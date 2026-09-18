// Registro del Service Worker para habilitar las capacidades PWA de Hermes
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('/sw.js')
            .then(reg => console.log('Hermes: Service Worker registrado correctamente'))
            .catch(err => console.error('Hermes: Error al registrar SW:', err));
    });
}

// Referencias a los elementos del DOM
const btnStart = document.getElementById('btnStart');
const btnStop = document.getElementById('btnStop');
const statusText = document.getElementById('status');
const transcriptionDiv = document.getElementById('transcription');
const audioPlayback = document.getElementById('audioPlayback');

// Variables globales para mantener el estado de la aplicación
let mediaRecorder;
let audioChunks = [];
let recognition;
let audioContext;
let gainNode;
let isRecording = false;

// 1. Inicialización del Reconocimiento de Voz (Speech-to-Text)
function initSpeechRecognition() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
        statusText.textContent = "Error: Tu navegador no soporta reconocimiento de voz. Usa Chrome o Edge.";
        btnStart.disabled = true;
        return false;
    }

    recognition = new SpeechRecognition();
    recognition.lang = 'es-ES';
    recognition.continuous = true;
    recognition.interimResults = true;

    recognition.onresult = (event) => {
        let interimTranscript = '';
        let finalTranscript = '';

        // Procesamos los resultados para separar el texto final del parcial
        for (let i = event.resultIndex; i < event.results.length; ++i) {
            if (event.results[i].isFinal) {
                finalTranscript += event.results[i][0].transcript + '\n';
            } else {
                interimTranscript += event.results[i][0].transcript;
            }
        }
        
        // Actualizamos el DOM con el texto procesado
        transcriptionDiv.textContent += finalTranscript;
        if (interimTranscript) {
            transcriptionDiv.textContent += interimTranscript; 
        }
    };

    recognition.onerror = (event) => {
        console.error('Hermes: Error de reconocimiento:', event.error);
        if (event.error === 'no-speech') {
            statusText.textContent = "No se detectó voz. Reiniciando escucha...";
        }
    };

    // Reiniciar automáticamente si se detiene mientras la grabación sigue activa
    recognition.onend = () => {
        if (isRecording) {
            recognition.start();
        }
    };

    return true;
}

// 2. Inicialización de Audio y Amplificación (Web Audio API)
async function initAudio() {
    try {
        // Solicitamos el micrófono desactivando el procesamiento nativo del navegador
        // para tener control total sobre la ganancia y evitar que el navegador comprima el audio.
        const stream = await navigator.mediaDevices.getUserMedia({ 
            audio: {
                echoCancellation: false,
                noiseSuppression: false,
                autoGainControl: false
            } 
        });

        // Creamos el contexto de audio y el nodo de origen (el micrófono)
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
        const source = audioContext.createMediaStreamSource(stream);

        // Creamos un nodo de ganancia para amplificar los sonidos en decibeles bajos
        gainNode = audioContext.createGain();
        // Un valor de 15.0 multiplica la amplitud de la onda, actuando como un amplificador fuerte
        gainNode.gain.value = 15.0; 

        // Creamos un destino para generar un nuevo MediaStream con el audio ya amplificado
        const destination = audioContext.createMediaStreamDestination();
        
        // Conectamos el grafo de audio: Micrófono -> Ganancia -> Destino
        source.connect(gainNode);
        gainNode.connect(destination);

        /* 
         * NOTA TÉCNICA IMPORTANTE PARA EL DESARROLLADOR:
         * La Web Speech API (SpeechRecognition) no permite pasarle un MediaStream 
         * personalizado en la mayoría de los navegadores. Por lo tanto, la transcripción 
         * usará el micrófono nativo del sistema, mientras que la grabación y reproducción 
         * (MediaRecorder) usarán este stream amplificado por la Web Audio API.
         */

        // Configuramos el MediaRecorder con el stream amplificado
        mediaRecorder = new MediaRecorder(destination.stream);
        
        mediaRecorder.ondataavailable = (event) => {
            if (event.data.size > 0) {
                audioChunks.push(event.data);
            }
        };

        mediaRecorder.onstop = () => {
            // Al detener, creamos un Blob con los fragmentos de audio
            const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
            const audioUrl = URL.createObjectURL(audioBlob);
            
            // Asignamos la URL al reproductor de audio nativo
            audioPlayback.src = audioUrl;
            audioChunks = [];
            statusText.textContent = "Hermes: Grabación finalizada. Puedes reproducir el audio amplificado.";
        };

        return stream;

    } catch (error) {
        console.error("Hermes: Error al acceder al micrófono:", error);
        statusText.textContent = "Error: No se pudo acceder al micrófono. Verifica los permisos.";
        return null;
    }
}

// 3. Controladores de Eventos de la Interfaz
btnStart.addEventListener('click', async () => {
    statusText.textContent = "Hermes: Iniciando sistemas...";
    
    // Inicializamos el motor de transcripción
    if (!initSpeechRecognition()) return;

    // Inicializamos el motor de audio y amplificación
    const micStream = await initAudio();
    if (!micStream) return;

    // Iniciamos la grabación del audio amplificado
    mediaRecorder.start();
    
    // Iniciamos el reconocimiento de voz (usa el micrófono nativo del sistema)
    recognition.start();

    isRecording = true;
    btnStart.disabled = true;
    btnStop.disabled = false;
    transcriptionDiv.textContent = "";
    statusText.textContent = "Hermes: Grabando y transcribiendo...";
});

btnStop.addEventListener('click', () => {
    isRecording = false;
    
    // Detenemos la grabación de audio
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
        mediaRecorder.stop();
    }
    
    // Detenemos el reconocimiento de voz
    if (recognition) {
        recognition.stop();
    }

    // Cerramos el contexto de audio para liberar los recursos del sistema
    if (audioContext && audioContext.state !== 'closed') {
        audioContext.close();
    }

    btnStart.disabled = false;
    btnStop.disabled = true;
});