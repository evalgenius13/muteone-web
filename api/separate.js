<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>MuteOne - AI Audio Separation</title>
  <style>
    body { font-family: sans-serif; background: #f5f5f5; padding: 20px; }
    .container { max-width: 600px; margin: auto; background: #fff; padding: 20px; border-radius: 10px; }
    .upload-area { border: 2px dashed #aaa; padding: 40px; text-align: center; cursor: pointer; }
    .instrument-option { display: inline-block; padding: 10px 20px; border: 1px solid #ccc; border-radius: 6px; margin: 5px; cursor: pointer; }
    .instrument-option.selected { background: #667eea; color: #fff; border-color: #667eea; }
    .progress { margin-top: 20px; display: none; }
    .progress-bar { width: 100%; background: #eee; height: 10px; border-radius: 4px; overflow: hidden; }
    .progress-fill { background: #667eea; height: 100%; width: 0%; transition: width 0.3s; }
    .result { margin-top: 20px; display: none; }
    .error { color: red; margin-top: 15px; display: none; }
  </style>
</head>
<body>
  <div class="container">
    <h2>MuteOne™ – AI Audio Separation</h2>

    <div class="upload-area" id="uploadArea">Drop file here or click</div>
    <input type="file" id="fileInput" accept=".mp3,.wav,.flac,.m4a" style="display:none">

    <h3>Remove:</h3>
    <div>
      <span class="instrument-option selected" data-instrument="voice">Vocals</span>
      <span class="instrument-option" data-instrument="drum">Drums</span>
      <span class="instrument-option" data-instrument="bass">Bass</span>
      <span class="instrument-option" data-instrument="piano">Piano</span>
      <span class="instrument-option" data-instrument="electric_guitar">Guitar</span>
      <span class="instrument-option" data-instrument="strings">Strings</span>
    </div>

    <button id="processBtn" disabled>Upload a file to get started</button>

    <div class="progress" id="progress">
      <div class="progress-bar"><div class="progress-fill" id="progressFill"></div></div>
      <p id="progressText">Processing...</p>
    </div>

    <div class="result" id="result">
      <p id="resultDescription"></p>
      <a id="downloadBtn" href="#" download>Download</a>
    </div>

    <div class="error" id="errorMessage"></div>
  </div>

<script>
let selectedFile = null;
let selectedInstrument = "voice";
let currentUploadId = null;
let pollingInterval = null;

const fileInput = document.getElementById("fileInput");
const uploadArea = document.getElementById("uploadArea");
const processBtn = document.getElementById("processBtn");
const progress = document.getElementById("progress");
const progressFill = document.getElementById("progressFill");
const progressText = document.getElementById("progressText");
const result = document.getElementById("result");
const resultDescription = document.getElementById("resultDescription");
const downloadBtn = document.getElementById("downloadBtn");
const errorMessage = document.getElementById("errorMessage");

uploadArea.addEventListener("click", () => fileInput.click());
uploadArea.addEventListener("dragover", e => { e.preventDefault(); });
uploadArea.addEventListener("drop", e => {
  e.preventDefault();
  if (e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]);
});
fileInput.addEventListener("change", e => {
  if (e.target.files.length) handleFile(e.target.files[0]);
});

document.querySelectorAll(".instrument-option").forEach(opt => {
  opt.addEventListener("click", () => {
    document.querySelectorAll(".instrument-option").forEach(o => o.classList.remove("selected"));
    opt.classList.add("selected");
    selectedInstrument = opt.dataset.instrument;
  });
});

function handleFile(file) {
  selectedFile = file;
  processBtn.disabled = false;
  processBtn.textContent = "Process Audio";
}

processBtn.addEventListener("click", async () => {
  if (!selectedFile) return;
  progress.style.display = "block";
  result.style.display = "none";
  showProgress(10, "Requesting upload authorization...");
  try {
    const authRes = await fetch("/api/separate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "upload", filename: selectedFile.name, stem: selectedInstrument })
    });
    const authData = await authRes.json();
    if (!authRes.ok) throw new Error(authData.error || "Auth failed");

    showProgress(30, "Uploading to LALAL.AI...");
    const formData = new FormData();
    formData.append("audio_file", selectedFile);
    const uploadRes = await fetch("https://www.lalal.ai/api/upload/", {
      method: "POST",
      headers: { "Authorization": authData.auth_header },
      body: formData
    });
    const uploadResult = await uploadRes.json();
    if (uploadResult.status !== "success") throw new Error(uploadResult.error || "Upload failed");

    currentUploadId = uploadResult.id;
    showProgress(50, "Starting processing...");

    await fetch("/api/separate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "process", uploadId: currentUploadId, stem: selectedInstrument })
    });

    pollForCompletion();
  } catch (err) {
    showError(err.message);
  }
});

function pollForCompletion() {
  let attempts = 0;
  pollingInterval = setInterval(async () => {
    attempts++;
    if (attempts > 60) {
      clearInterval(pollingInterval);
      showError("Timed out");
      return;
    }
    try {
      const res = await fetch("/api/separate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "check_status", uploadId: currentUploadId })
      });
      const data = await res.json();
      if (data.processing) {
        showProgress(Math.min(90, 50 + attempts), data.message);
      } else if (data.ok) {
        clearInterval(pollingInterval);
        showProgress(100, "Complete!");
        result.style.display = "block";
        resultDescription.textContent = data.message;
        downloadBtn.href = data.back_track_url;
        downloadBtn.download = selectedFile.name.replace(/\.[^/.]+$/, "") + "_processed.mp3";
      }
    } catch (e) {
      clearInterval(pollingInterval);
      showError(e.message);
    }
  }, 5000);
}

function showProgress(percent, text) {
  progressFill.style.width = percent + "%";
  progressText.textContent = text;
}

function showError(msg) {
  errorMessage.textContent = msg;
  errorMessage.style.display = "block";
}
</script>
</body>
</html>
