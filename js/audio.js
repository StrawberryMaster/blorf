/**
 * js/audio.js
 */

let audioCtx = null;
let masterGain = null;
let analyser = null;
let isSFXMuted = false;

// reverb node
let reverbNode = null;

export function toggleSFX() {
    isSFXMuted = !isSFXMuted;
    return isSFXMuted;
}

// create a simple reverb impulse response
function createReverbBuffer() {
    const sampleRate = audioCtx.sampleRate;
    const length = sampleRate * 1.5; // 1.5 second reverb
    const impulse = audioCtx.createBuffer(2, length, sampleRate);
    
    for (let channel = 0; channel < 2; channel++) {
        const channelData = impulse.getChannelData(channel);
        for (let i = 0; i < length; i++) {
            // exponentially decaying noise
            const decay = 1 - i / length;
            channelData[i] = (Math.random() * 2 - 1) * decay * decay * decay;
        }
    }
    
    return impulse;
}

// initialize audio context
export function initAudio() {
    if (!audioCtx) {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        audioCtx = new AudioContext();
        
        // create analyser for visualization
        analyser = audioCtx.createAnalyser();
        analyser.fftSize = 2048;
        
        // create reverb
        reverbNode = audioCtx.createConvolver();
        reverbNode.buffer = createReverbBuffer();
        
        const reverbGain = audioCtx.createGain();
        reverbGain.gain.value = 0.15; // subtle reverb
        
        masterGain = audioCtx.createGain();
        masterGain.gain.value = 0.25; // master volume
        
        // master -> reverb -> analyser -> speaker
        masterGain.connect(analyser);
        masterGain.connect(reverbGain);
        reverbGain.connect(reverbNode);
        reverbNode.connect(analyser);
        analyser.connect(audioCtx.destination);
    }
    
    if (audioCtx.state === 'suspended') {
        audioCtx.resume();
    }
}

// the core synth engine
function playSynth(options = {}) {
    if (!audioCtx || isSFXMuted) return null;
    
    const t = options.startTime ?? audioCtx.currentTime;
    const {
        type = 'sine', freq = 440, freqEnd = null, duration = 0.2,
        attack = 0.02, release = 0.1, peakGain = 0.3,
        filterFreq = null, filterFreqEnd = null, filterQ = 1, detune = 0,
        dest = masterGain
    } = options;
    
    const osc = audioCtx.createOscillator();
    const gainNode = audioCtx.createGain();
    
    osc.type = type;
    osc.detune.value = detune;
    
    // frequency envelope (pitch sweep)
    osc.frequency.setValueAtTime(freq, t);
    if (freqEnd) osc.frequency.exponentialRampToValueAtTime(freqEnd, t + duration);
    
    // volume envelope (ADSR)
    gainNode.gain.setValueAtTime(0, t);
    gainNode.gain.linearRampToValueAtTime(peakGain, t + attack);
    gainNode.gain.setValueAtTime(peakGain, t + duration - release);
    gainNode.gain.exponentialRampToValueAtTime(0.001, t + duration);
    
    let currentNode = osc;
    
    // lowpass filter for warmth
    if (filterFreq) {
        const filter = audioCtx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.Q.value = filterQ;
        filter.frequency.setValueAtTime(filterFreq, t);
        if (filterFreqEnd) filter.frequency.exponentialRampToValueAtTime(filterFreqEnd, t + duration);
        
        currentNode.connect(filter);
        currentNode = filter;
    }
    
    currentNode.connect(gainNode);
    
    // route to destination(s)
    if (Array.isArray(dest)) {
        dest.forEach(d => gainNode.connect(d));
    } else {
        gainNode.connect(dest);
    }
    
    osc.start(t);
    osc.stop(t + duration);
    
    return gainNode;
}

export function playClick() {
    initAudio();
    const t = audioCtx.currentTime;
    playSynth({ freq: 520, startTime: t, duration: 0.15, attack: 0.005, release: 0.08, peakGain: 0.2, filterFreq: 2000 });
    playSynth({ freq: 780, startTime: t, duration: 0.09, attack: 0.01, release: 0.05, peakGain: 0.1 });
}

export function playToggleOn() {
    initAudio();
    const t = audioCtx.currentTime;
    [0, 8].forEach(detune => {
        playSynth({ 
            freq: 300, freqEnd: 600, startTime: t, duration: 0.2, peakGain: 0.15, detune, 
            filterFreq: 1200, filterFreqEnd: 2400 
        });
    });
}

export function playToggleOff() {
    initAudio();
    playSynth({ 
        freq: 600, freqEnd: 280, startTime: audioCtx.currentTime, duration: 0.18, peakGain: 0.18,
        filterFreq: 2000, filterFreqEnd: 400, filterQ: 1.5 
    });
}

export function playStart() {
    initAudio();
    const t = audioCtx.currentTime;
    [523.25, 659.25, 783.99, 1046.50].forEach((freq, i) => {
        const st = t + (i * 0.08);
        playSynth({ freq, startTime: st, duration: 0.5, attack: 0.015, release: 0.25, peakGain: 0.2, filterFreq: 3500 });
        playSynth({ freq: freq * 2, startTime: st, duration: 0.35, attack: 0.03, release: 0.2, peakGain: 0.08 });
    });
}

export function playError() {
    initAudio();
    const t = audioCtx.currentTime;
    [440, 330].forEach((freq, i) => {
        playSynth({ freq, startTime: t + (i * 0.15), duration: 0.15, peakGain: 0.25, filterFreq: 2000, filterQ: 2 });
    });
}

export function playAlert() {
    initAudio();
    if (isSFXMuted) return;
    
    const t = audioCtx.currentTime;
    
    // custom delay chain just for the alert
    const delay = audioCtx.createDelay(1.0);
    delay.delayTime.value = 0.18;
    const feedback = audioCtx.createGain();
    feedback.gain.value = 0.3;
    const delayFilter = audioCtx.createBiquadFilter();
    delayFilter.frequency.value = 1800;
    
    delay.connect(feedback);
    feedback.connect(delayFilter);
    delayFilter.connect(delay);
    delay.connect(masterGain);
    
    [659.25, 783.99, 987.77].forEach((freq, i) => {
        playSynth({ 
            freq, startTime: t + (i * 0.12), duration: 0.35, peakGain: 0.22, 
            filterFreq: 3000, dest: [masterGain, delay] 
        });
    });
}

export function playUpgradeSound() {
    initAudio();
    const now = audioCtx.currentTime;
    const notes = [523.25, 659.25, 783.99, 987.77];
    
    [0, 0.65].forEach(delayOffset => {
        notes.forEach((freq, i) => {
            const st = now + delayOffset + (i * 0.10);
            playSynth({ freq, startTime: st, duration: 0.45, attack: 0.01, release: 0.2, peakGain: 0.22, filterFreq: 4000 });
            playSynth({ freq: freq * 2, startTime: st, duration: 0.36, attack: 0.02, release: 0.15, peakGain: 0.12 });
            playSynth({ freq: freq * 0.5, startTime: st, duration: 0.22, attack: 0.015, release: 0.1, peakGain: 0.08, filterFreq: 1000 });
        });
    });
}

export function playCat5Sound() {
    initAudio();
    const now = audioCtx.currentTime;
    const notes = [523.25, 659.25, 783.99, 987.77, 1174.66];
    
    [0, 0.75].forEach(delayOffset => {
        notes.forEach((freq, i) => {
            const st = now + delayOffset + (i * 0.09);
            // main bell
            playSynth({ freq, startTime: st, duration: 0.6, attack: 0.015, peakGain: 0.25, filterFreq: 4500, filterQ: 0.8 });
            // sparkle (long reverb decay)
            playSynth({ freq: freq * 2, startTime: st, duration: 2.8, attack: 0.03, peakGain: 0.15 });
            // sub-bass (first 3 notes only)
            if (i < 3) {
                playSynth({ freq: freq * 0.5, startTime: st, duration: 0.4, attack: 0.02, peakGain: 0.12, filterFreq: 800 });
            }
        });
    });
}

export function getAnalyser() {
    return analyser;
}