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

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = Flask(__name__)
app.config['MAX_CONTENT_LENGTH'] = 10 * 1024 * 1024  # 10MB limit

# Store processing jobs in memory (since we don't persist anything)
processing_jobs = {}

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/api/process', methods=['POST'])
def process_audio():
    try:
        if 'file' not in request.files:
            return jsonify({'error': 'No file uploaded'}), 400
        
        file = request.files['file']
        remove = request.form.get('remove', 'vocals')
        
        if file.filename == '':
            return jsonify({'error': 'No file selected'}), 400
        
        if not file.filename.lower().endswith(('.mp3', '.wav', '.m4a', '.flac', '.ogg')):
            return jsonify({'error': 'Invalid file type. Please use MP3, WAV, M4A, FLAC, or OGG'}), 400
        
        # Generate unique job ID
        job_id = str(uuid.uuid4())
        
        # Start processing in background
        thread = threading.Thread(
            target=process_audio_background,
            args=(file, remove, job_id)
        )
        thread.start()
        
        # Store job info
        processing_jobs[job_id] = {
            'status': 'processing',
            'message': f'Processing - removing {remove}... (2-5 minutes)',
            'result_path': None
        }
        
        return jsonify({
            'jobId': job_id,
            'status': 'processing',
            'message': f'Started processing - removing {remove}...'
        })
        
    except Exception as e:
        logger.error(f'Process error: {str(e)}')
        return jsonify({'error': 'Processing failed. Please try again.'}), 500

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
            # Send file and clean up
            def cleanup():
                time.sleep(1)  # Give time for download to start
                try:
                    os.unlink(result_path)
                    del processing_jobs[job_id]
                except:
                    pass
            
            threading.Thread(target=cleanup).start()
            
            return send_file(
                result_path,
                as_attachment=True,
                download_name=f"processed_{int(time.time())}.mp3",
                mimetype='audio/mpeg'
            )
        else:
            return jsonify({'error': 'File not found'}), 404
            
    except Exception as e:
        logger.error(f'Download error: {str(e)}')
        return jsonify({'error': 'Download failed'}), 500

def process_audio_background(file, remove_stem, job_id):
    """Background processing function"""
    try:
        with tempfile.TemporaryDirectory() as temp_dir:
            # Save uploaded file
            input_path = os.path.join(temp_dir, secure_filename(file.filename))
            file.save(input_path)
            
            # Update status
            processing_jobs[job_id]['message'] = f'Running AI separation - removing {remove_stem}...'
            
            # Run Demucs separation
            output_dir = os.path.join(temp_dir, 'separated')
            run_demucs_separation(input_path, output_dir)
            
            # Update status
            processing_jobs[job_id]['message'] = f'Creating final mix without {remove_stem}...'
            
            # Create final mix
            result_path = create_final_mix(output_dir, remove_stem, temp_dir, input_path)
            
            # Move result to a permanent temp location
            final_result_path = f"/tmp/result_{job_id}.mp3"
            os.rename(result_path, final_result_path)
            
            # Update job status
            processing_jobs[job_id].update({
                'status': 'completed',
                'message': f'Complete! Successfully removed {remove_stem}.',
                'result_path': final_result_path
            })
            
    except Exception as e:
        logger.error(f'Background processing error: {str(e)}')
        processing_jobs[job_id].update({
            'status': 'failed',
            'message': f'Processing failed: {str(e)}'
        })

def run_demucs_separation(input_path, output_dir):
    """Run Demucs audio separation"""
    cmd = [
        'python', '-m', 'demucs.separate',
        '--mp3',
        '--mp3-bitrate', '320',
        '-n', 'htdemucs',  # High quality model
        '--out', output_dir,
        input_path
    ]
    
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise Exception(f"Demucs separation failed: {result.stderr}")

def create_final_mix(output_dir, remove_stem, temp_dir, input_path):
    """Create final mix without specified stem"""
    base_name = Path(input_path).stem
    stems_dir = os.path.join(output_dir, 'htdemucs', base_name)
    
    stem_files = {
        'vocals': os.path.join(stems_dir, 'vocals.mp3'),
        'drums': os.path.join(stems_dir, 'drums.mp3'),
        'bass': os.path.join(stems_dir, 'bass.mp3'),
        'other': os.path.join(stems_dir, 'other.mp3')
    }
    
    # Build FFmpeg command for mixing
    inputs = []
    filter_parts = []
    input_count = 0
    
    for stem_name, file_path in stem_files.items():
        if stem_name != remove_stem and os.path.exists(file_path):
            inputs.extend(['-i', file_path])
            filter_parts.append(f'[{input_count}:a]')
            input_count += 1
    
    if input_count == 0:
        raise Exception(f"No stems found to mix (tried to remove {remove_stem})")
    
    output_path = os.path.join(temp_dir, 'final_result.mp3')
    
    if input_count == 1:
        # Single stem, just copy
        cmd = ['ffmpeg', '-i', inputs[1], '-c:a', 'libmp3lame', '-b:a', '320k', '-y', output_path]
    else:
        # Multiple stems, mix them
        filter_expr = ''.join(filter_parts) + f'amix=inputs={input_count}:duration=longest[out]'
        cmd = ['ffmpeg', '-y', *inputs, '-filter_complex', filter_expr, '-map', '[out]', 
               '-c:a', 'libmp3lame', '-b:a', '320k', output_path]
    
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise Exception(f"Audio mixing failed: {result.stderr}")
    
    return output_path

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    app.run(host='0.0.0.0', port=port, debug=False)
