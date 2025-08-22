\# Ultra-minimal version using lighter separation
FROM python:3.11-slim

# Install only FFmpeg
RUN apt-get update && apt-get install -y \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install minimal Python deps
RUN pip install --no-cache-dir \
    Flask==2.3.3 \
    numpy==1.24.3 \
    soundfile==0.12.1 \
    gunicorn==21.2.0

# Copy application
COPY app_minimal.py app.py
COPY templates/ templates/

EXPOSE 5000
CMD ["gunicorn", "--bind", "0.0.0.0:5000", "--timeout", "300", "app:app"]
