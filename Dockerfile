# Use Python 3.11 slim base image
FROM python:3.11-slim

# Set environment variables
ENV PYTHONUNBUFFERED=1
ENV DEBIAN_FRONTEND=noninteractive
ENV TORCH_HOME=/tmp/torch
ENV HF_HOME=/tmp/huggingface

# Install system dependencies
RUN apt-get update && apt-get install -y \
    ffmpeg \
    gcc \
    g++ \
    make \
    wget \
    curl \
    git \
    && rm -rf /var/lib/apt/lists/* \
    && apt-get clean

# Set working directory
WORKDIR /app

# Create cache directories
RUN mkdir -p /tmp/torch /tmp/huggingface

# Copy requirements file
COPY requirements.txt .

# Install Python dependencies
RUN pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir -r requirements.txt

# Copy application files
COPY app.py .
COPY templates/ templates/

# Create necessary directories
RUN mkdir -p /tmp/uploads /tmp/results

# Set proper permissions
RUN chmod -R 777 /tmp/

# Expose port
EXPOSE 5000

# Health check: use the platform $PORT and a cheap /health path
HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=3 \
  CMD sh -c 'curl -fsS "http://127.0.0.1:${PORT:-5000}/health" || exit 1'

# Start the application with gunicorn (production server) - FIXED PORT + REDUCED THREADS
CMD gunicorn --bind 0.0.0.0:${PORT:-5000} --workers 1 --threads 1 --timeout 600 app:app
