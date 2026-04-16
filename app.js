// DOM Elements
const mainButton = document.getElementById('mainButton');
const buttonText = mainButton.querySelector('.button-text');
const statusIndicator = document.getElementById('statusIndicator');
const statusText = document.getElementById('statusText');
const conversation = document.getElementById('conversation');
const visualizer = document.getElementById('visualizer');
const silenceThresholdInput = document.getElementById('silenceThreshold');
const silenceDurationInput = document.getElementById('silenceDuration');
const errorToast = document.getElementById('errorToast');

// State Variables
let ws = null;
let audioContext = null;
let mediaRecorder = null;
let analyser = null;
let audioChunks = [];
let isRecording = false;
let silenceTimer = null;
let animationFrameId = null;

// Configuration
// const WS_URL = 'ws://localhost:8000'; // Update this if your backend is hosted elsewhere
const WS_URL = 'wss://aurora-backend-gpu-434142152947.us-east4.run.app'; // For cloud

// Initialize App
function init() {
    mainButton.disabled = false;
    setupVisualizerBars();
    
    mainButton.addEventListener('click', () => {
        if (!ws || ws.readyState !== WebSocket.OPEN) {
            connectWebSocket();
        } else if (!isRecording) {
            startRecording();
        } else {
            stopRecording();
        }
    });
}

// WebSocket Management
function connectWebSocket() {
    updateUIState('connecting');
    ws = new WebSocket(WS_URL);

    ws.onopen = async () => {
        try {
            await setupAudio();
            updateUIState('connected');
            addMessage('system', 'Connected to server. Click to start speaking.');
        } catch (err) {
            showError('Microphone access denied.');
            ws.close();
        }
    };

    ws.onmessage = handleServerMessage;

    ws.onclose = () => {
        updateUIState('disconnected');
        addMessage('system', 'Disconnected from server.');
    };

    ws.onerror = (error) => {
        showError('WebSocket connection error.');
        updateUIState('disconnected');
    };
}

// Handle Incoming Server Messages
async function handleServerMessage(event) {
    // If the data is binary (Blob), it's the TTS audio output
    if (event.data instanceof Blob) {
        updateUIState('speaking');
        playAudioResponse(event.data);
        return;
    }

    // Otherwise, it's JSON control/text data
    const data = JSON.parse(event.data);

    switch (data.type) {
        case 'transcription':
            addMessage('user', data.text);
            updateUIState('processing');
            break;
        case 'response':
            addMessage('assistant', data.text);
            if (data.end_conversation) {
                addMessage('system', 'Conversation ended.');
            }
            break;
        case 'error':
            showError(data.message);
            updateUIState('connected');
            break;
        case 'tts_complete':
            // Handled when audio actually finishes playing
            break;
    }
}

// Audio Recording Setup
async function setupAudio() {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    const source = audioContext.createMediaStreamSource(stream);
    
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);

    // Use webm for browser recording (supported by Google STT AutoDetect)
    mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });

    mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunks.push(e.data);
    };

    mediaRecorder.onstop = () => {
        const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(audioBlob); // Send binary data to Python server
        }
        audioChunks = [];
    };
}

// Start Recording & Silence Detection
function startRecording() {
    if (!mediaRecorder) return;
    
    audioChunks = [];
    mediaRecorder.start();
    isRecording = true;
    updateUIState('recording');
    
    // Start Audio Visualizer and Voice Activity Detection (VAD)
    visualizer.classList.add('active');
    monitorAudioLevel();
}

function stopRecording() {
    if (mediaRecorder && mediaRecorder.state === 'recording') {
        mediaRecorder.stop();
        isRecording = false;
        cancelAnimationFrame(animationFrameId);
        resetVisualizer();
        visualizer.classList.remove('active');
        updateUIState('processing');
    }
}

// Voice Activity Detection (VAD) and Visualization
function monitorAudioLevel() {
    const dataArray = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(dataArray);

    // Calculate average volume
    const sum = dataArray.reduce((a, b) => a + b, 0);
    const averageVolume = sum / dataArray.length;
    const normalizedVolume = averageVolume / 255; // Scale 0 to 1

    // Update Visualizer UI
    updateVisualizer(dataArray);

    // Silence Detection Logic
    const threshold = parseFloat(silenceThresholdInput.value);
    const maxSilenceMs = parseFloat(silenceDurationInput.value) * 1000;

    if (normalizedVolume < threshold) {
        if (!silenceTimer) {
            silenceTimer = Date.now();
        } else if (Date.now() - silenceTimer > maxSilenceMs) {
            stopRecording(); // User stopped speaking, trigger send
            return;
        }
    } else {
        silenceTimer = null; // Reset timer if volume goes above threshold
    }

    if (isRecording) {
        animationFrameId = requestAnimationFrame(monitorAudioLevel);
    }
}

// Play TTS Audio from Server
function playAudioResponse(blob) {
    const audioUrl = URL.createObjectURL(blob);
    const audio = new Audio(audioUrl);
    
    // Optional: Connect to analyser to visualize server response too
    // Note: requires dealing with CORS or local object URLs in standard setups
    
    audio.play();
    
    audio.onended = () => {
        URL.revokeObjectURL(audioUrl);
        updateUIState('connected');
    };

    audio.onerror = () => {
        showError('Error playing audio response.');
        updateUIState('connected');
    };
}

// --- UI Helpers ---

function updateUIState(state) {
    mainButton.classList.remove('recording');
    statusIndicator.className = 'status-indicator';
    
    switch(state) {
        case 'connecting':
            buttonText.textContent = 'Connecting...';
            statusText.textContent = 'Connecting to Server...';
            mainButton.disabled = true;
            break;
        case 'connected':
            buttonText.textContent = 'Start Speaking';
            statusText.textContent = 'Ready';
            statusIndicator.classList.add('connected');
            mainButton.disabled = false;
            break;
        case 'recording':
            buttonText.textContent = 'Listening...';
            statusText.textContent = 'Recording (Auto-stops on silence)';
            mainButton.classList.add('recording');
            statusIndicator.classList.add('recording');
            break;
        case 'processing':
            buttonText.innerHTML = 'Thinking <div class="loading-spinner"></div>';
            statusText.textContent = 'Processing...';
            statusIndicator.classList.add('processing');
            mainButton.disabled = true;
            break;
        case 'speaking':
            buttonText.innerHTML = 'Speaking...';
            statusText.textContent = 'Assistant Speaking';
            statusIndicator.classList.add('connected');
            mainButton.disabled = true;
            break;
        case 'disconnected':
            buttonText.textContent = 'Connect';
            statusText.textContent = 'Disconnected';
            mainButton.disabled = false;
            break;
    }
}

function addMessage(role, text) {
    const msgDiv = document.createElement('div');
    msgDiv.className = `message ${role}`;
    
    const header = document.createElement('div');
    header.className = 'message-header';
    header.textContent = role === 'user' ? 'You' : role === 'assistant' ? 'Aurora' : '';
    
    const content = document.createElement('div');
    content.textContent = text;
    
    if (role !== 'system') msgDiv.appendChild(header);
    msgDiv.appendChild(content);
    
    conversation.appendChild(msgDiv);
    conversation.scrollTop = conversation.scrollHeight; // Auto-scroll
}

function showError(msg) {
    errorToast.textContent = msg;
    errorToast.classList.add('show');
    setTimeout(() => errorToast.classList.remove('show'), 3000);
}

// Visualizer UI setup
const BAR_COUNT = 15;
function setupVisualizerBars() {
    for (let i = 0; i < BAR_COUNT; i++) {
        const bar = document.createElement('div');
        bar.className = 'bar';
        visualizer.appendChild(bar);
    }
}

function updateVisualizer(dataArray) {
    const bars = visualizer.children;
    const step = Math.floor(dataArray.length / BAR_COUNT);
    
    for (let i = 0; i < BAR_COUNT; i++) {
        // Grab a frequency bin to determine bar height
        const value = dataArray[i * step];
        const height = Math.max(4, (value / 255) * 40); // Max 40px height
        bars[i].style.height = `${height}px`;
    }
}

function resetVisualizer() {
    const bars = visualizer.children;
    for (let i = 0; i < bars.length; i++) {
        bars[i].style.height = '4px';
    }
}

// Boot up
window.addEventListener('DOMContentLoaded', init);
