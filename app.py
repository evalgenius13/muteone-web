from flask import Flask, render_template, request, jsonify, send_file
import os
import tempfile
import subprocess
import logging
from pathlib import Path
import uuid
from werkzeug.utils import secure_filename
import threading
import time
import shutil
import io

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = Flask(__name__)
app.config['MAX_CONTENT_LENGTH'] = 50 * 1024 * 1024  # 50MB limit

# Store processing jobs in memory
processing_jobs = {}

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/health')
def health():
    return jsonify({'status': 'healthy', 'service': 'MuteOne'}), 200

@app.route('/api/process', methods=['POST'])
def process_audio():
    try:
        if 'file' not in request.files:
            return jsonify({'error': 'No file uploaded'}), 400
        
        file = request.files['file']
        remove = request.form.get('remove', 'vocals')
        
        if file.filename == '':
            return jsonify({'error': 'No file selected'}), 400
        
        # Validate file type
        allowed_extensions = {'.mp3', '.wav', '.m4a', '.flac', '.ogg', '.aac'}
        file_ext = Path(file.filename).suffix.lower()
        if file_ext not in allowed_extensions:
            return jsonify({'error': f'Invalid file type: {file_ext}. Supported: {", ".join(allowed_extensions)}'}), 400
        
        # Validate remove parameter
        if remove not in ['vocals', 'bass', 'drums', 'other']:
            return jsonify({'error': 'Invalid remove parameter. Must be: vocals, bass, drums, or other'}), 400
        
        # Generate unique job ID
        job_id = str(uuid.uuid4())
        
        # Read the entire file into memory immediately
        file.seek(0)  # Reset to beginning
        file_content = file.read()
        original_filename = secure_filename(file.filename)
        
        logger.info(f'Read file {original_filename}: {len(file_content)} bytes')
        
        # Initialize job status
        processing_jobs[job_id] = {
            'status': 'starting',
            'message': f'Starting processing - removing {remove}...',
            'result_path': None,
            'progress': 0,
            'original_name': Path(original_filename).stem,
            'remove_type': remove
        }
        
        # Start processing in background with file content
        thread = threading.Thread(
            target=process_audio_background,
            args=(file_content, original_filename, remove, job_id),
            daemon=True
        )
        thread.start()
        
        return jsonify({
            'jobId': job_id,
            'status': 'processing',
            'message': f'Started processing - removing {remove}...'
        })
        
    except Exception as e:
        logger.error(f'Process error: {str(e)}', exc_info=True)
        return jsonify({'error': f'Processing failed: {str(e)}'}), 500

@app.route('/api/status/<job_id>')
def check_status(job_id):
    if job_id not in processing_jobs:
        return jsonify({'error': 'Job not found'}), 404
    
    job = processing_jobs[job_id]
    return jsonify(job)

@app.route('/api/download/<job_id>')
def download_result(job_id):
    if job_id not in processing_jobs:
        return jsonify({'error': 'Job not found'}), 404
    
    job = processing_jobs[job_id]
    if job['status'] != 'completed' or not job['result_path']:
        return jsonify({'error': 'File not ready'}), 400
    
    try:
        result_path = job['result_path']
        if os.path.exists(result_path):
            # Get original filename info
            original_name = job.get('original_name', 'processed')
            remove_type = job.get('remove_type', 'unknown')
            
            # Send file with cleanup
            def cleanup():
                time.sleep(2)  # Give time for download to start
                try:
                    if os.path.exists(result_path):
                        os.unlink(result_path)
                    # Clean up job after 5 minutes
                    threading.Timer(300, lambda: processing_jobs.pop(job_id, None)).start()
                except Exception as e:
                    logger.warning(f'Cleanup error: {e}')
            
            threading.Thread(target=cleanup, daemon=True).start()
            
            return send_file(
                result_path,
                as_attachment=True,
                download_name=f"{original_name}_no_{remove_type}.mp3",
                mimetype='audio/mpeg'
            )
        else:
            return jsonify({'error': 'File not found'}), 404
            
    except Exception as e:
        logger.error(f'Download error: {str(e)}', exc_info=True)
        return jsonify({'error': 'Download failed'}), 500

def process_audio_background(file_content, original_filename, remove_stem, job_id):
    """Background processing function with proper file handling"""
    temp_dir = None
    try:
        # Create temporary directory
        temp_dir = tempfile.mkdtemp(prefix='muteone_')
        logger.info(f'Created temp directory: {temp_dir}')
        
        # Update job status
        processing_jobs[job_id].update({
            'status': 'processing',
            'message': 'Saving uploaded file...',
            'progress': 10
        })
        
        # Write file content to disk
        input_path = os.path.join(temp_dir, f'input_{original_filename}')
        with open(input_path, 'wb') as f:
            f.write(file_content)
        
        logger.info(f'Saved input file: {input_path} ({len(file_content)} bytes)')
        
        # Verify file was written correctly
        if not os.path.exists(input_path):
            raise Exception("Failed to save input file")
        
        file_size = os.path.getsize(input_path)
        if file_size != len(file_content):
            raise Exception(f"File size mismatch: expected {len(file_content)}, got {file_size}")
        
        # Update status
        processing_jobs[job_id].update({
            'message': f'Running AI separation (removing {remove_stem})...',
            'progress': 20
        })
        
        # Run Demucs separation
        output_dir = os.path.join(temp_dir, 'separated')
        run_demucs_separation(input_path, output_dir, job_id)
        
        # Update status
        processing_jobs[job_id].update({
            'message': f'Creating final mix without {remove_stem}...',
            'progress': 80
        })
        
        # Create final mix
        result_path = create_final_mix(output_dir, remove_stem, temp_dir, input_path, job_id)
        
        # Move result to a more permanent location
        final_result_path = f"/tmp/result_{job_id}_{int(time.time())}.mp3"
        shutil.move(result_path, final_result_path)
        
        # Update job status to completed
        processing_jobs[job_id].update({
            'status': 'completed',
            'message': f'Complete! Successfully removed {remove_stem}.',
            'result_path': final_result_path,
            'progress': 100
        })
        
        logger.info(f'Processing completed successfully for job {job_id}')
        
    except Exception as e:
        logger.error(f'Background processing error for job {job_id}: {str(e)}', exc_info=True)
        processing_jobs[job_id].update({
            'status': 'failed',
            'message': f'Processing failed: {str(e)}',
            'progress': 0
        })
    finally:
        # Clean up temp directory
        if temp_dir and os.path.exists(temp_dir):
            try:
                shutil.rmtree(temp_dir)
                logger.info(f'Cleaned up temp directory: {temp_dir}')
            except Exception as e:
                logger.warning(f'Failed to clean up temp directory: {e}')

def run_demucs_separation(input_path, output_dir, job_id):
    """Run Demucs audio separation with progress updates"""
    try:
        # Ensure output directory exists
        os.makedirs(output_dir, exist_ok=True)
        
        # Update progress
        processing_jobs[job_id].update({
            'message': 'Loading AI model...',
            'progress': 30
        })
        
        # Build Demucs command
        cmd = [
            'python', '-m', 'demucs.separate',
            '--mp3',
            '--mp3-bitrate', '320',
            '-n', 'htdemucs',  # High-quality model
            '--out', output_dir,
            input_path
        ]
        
        logger.info(f'Running Demucs command: {" ".join(cmd)}')
        
        # Update progress
        processing_jobs[job_id].update({
            'message': 'AI separation in progress...',
            'progress': 50
        })
        
        # Run the command with environment variables
        env = os.environ.copy()
        env['TORCH_HOME'] = '/tmp/torch'
        env['HF_HOME'] = '/tmp/huggingface'
        
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=600, env=env)
        
        if result.returncode != 0:
            logger.error(f'Demucs stderr: {result.stderr}')
            logger.error(f'Demucs stdout: {result.stdout}')
            raise Exception(f"Demucs separation failed: {result.stderr}")
        
        logger.info('Demucs separation completed successfully')
        
        # Update progress
        processing_jobs[job_id].update({
            'progress': 70
        })
        
    except subprocess.TimeoutExpired:
        raise Exception("Processing timeout. Please try with a shorter audio file.")
    except Exception as e:
        raise Exception(f"Audio separation failed: {str(e)}")

def create_final_mix(output_dir, remove_stem, temp_dir, input_path, job_id):
    """Create final mix without specified stem"""
    try:
        base_name = Path(input_path).stem
        stems_dir = os.path.join(output_dir, 'htdemucs', base_name)
        
        if not os.path.exists(stems_dir):
            raise Exception(f"Stems directory not found: {stems_dir}")
        
        stem_files = {
            'vocals': os.path.join(stems_dir, 'vocals.mp3'),
            'drums': os.path.join(stems_dir, 'drums.mp3'),
            'bass': os.path.join(stems_dir, 'bass.mp3'),
            'other': os.path.join(stems_dir, 'other.mp3')
        }
        
        # Check which stems exist
        existing_stems = {k: v for k, v in stem_files.items() if os.path.exists(v)}
        logger.info(f'Found stems: {list(existing_stems.keys())}')
        
        # Remove the specified stem
        stems_to_mix = {k: v for k, v in existing_stems.items() if k != remove_stem}
        
        if not stems_to_mix:
            raise Exception(f"No stems available for mixing after removing {remove_stem}")
        
        logger.info(f'Mixing stems: {list(stems_to_mix.keys())}')
        
        # Build FFmpeg command
        output_path = os.path.join(temp_dir, 'final_result.mp3')
        
        if len(stems_to_mix) == 1:
            # Single stem, just copy
            single_stem = list(stems_to_mix.values())[0]
            cmd = [
                'ffmpeg', '-y',
                '-i', single_stem,
                '-c:a', 'libmp3lame',
                '-b:a', '320k',
                output_path
            ]
        else:
            # Multiple stems, mix them
            inputs = []
            for stem_path in stems_to_mix.values():
                inputs.extend(['-i', stem_path])
            
            filter_parts = [f'[{i}:a]' for i in range(len(stems_to_mix))]
            filter_expr = ''.join(filter_parts) + f'amix=inputs={len(stems_to_mix)}:duration=longest[out]'
            
            cmd = [
                'ffmpeg', '-y',
                *inputs,
                '-filter_complex', filter_expr,
                '-map', '[out]',
                '-c:a', 'libmp3lame',
                '-b:a', '320k',
                output_path
            ]
        
        logger.info(f'Running FFmpeg command: {" ".join(cmd)}')
        
        # Update progress
        processing_jobs[job_id].update({
            'message': 'Finalizing audio...',
            'progress': 90
        })
        
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
        
        if result.returncode != 0:
            logger.error(f'FFmpeg stderr: {result.stderr}')
            raise Exception(f"Audio mixing failed: {result.stderr}")
        
        if not os.path.exists(output_path):
            raise Exception("Final audio file was not created")
        
        logger.info(f'Final mix created: {output_path} ({os.path.getsize(output_path)} bytes)')
        return output_path
        
    except Exception as e:
        raise Exception(f"Final mix creation failed: {str(e)}")

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    debug = os.environ.get('FLASK_ENV') == 'development'
    
    logger.info(f'Starting MuteOne app on port {port}')
    app.run(host='0.0.0.0', port=port, debug=debug, threaded=True)
