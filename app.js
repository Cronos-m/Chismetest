let recognition = null;
let wordCounter = 0;
let isListening = false;

const btnStart = document.getElementById('btn-start');
const displayContainer = document.getElementById('display-container');
const loader = document.getElementById('loader');
const currentWordEl = document.getElementById('current-word');
const wordsListEl = document.getElementById('words-list');

// Inicializacion de la API nativa de reconocimiento de voz
function initSpeech() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

  if (!SpeechRecognition) {
    alert('Tu navegador no soporta el reconocimiento de voz nativo. Prueba en Safari (iOS) o Chrome (Android).');
    return null;
  }

  const rec = new SpeechRecognition();
  rec.continuous = true;
  rec.interimResults = true;
  rec.lang = 'es-ES';

  rec.onresult = (event) => {
    let interimText = '';
    let finalText = '';

    for (let i = event.resultIndex; i < event.results.length; ++i) {
      if (event.results[i].isFinal) {
        finalText += event.results[i][0].transcript;
      } else {
        interimText += event.results[i][0].transcript;
      }
    }

    // Muestra la palabra mientras se esta pronunciando en tiempo real
    if (interimText.trim().length > 0) {
      loader.style.display = 'none';
      currentWordEl.textContent = interimText.trim().toUpperCase();
    }

    // Cuando detecta el final de la palabra/frase, la añade a la lista
    if (finalText.trim().length > 0) {
      addWordToList(finalText.trim().toUpperCase());
    }
  };

  rec.onerror = (e) => {
    console.error('Error de voz:', e.error);
  };

  // Mantiene el microfono escuchando sin interrupciones
  rec.onend = () => {
    if (isListening) {
      try {
        rec.start();
      } catch (err) {
        console.warn('Reintento de inicio:', err);
      }
    }
  };

  return rec;
}

// Pasa la palabra actual a la lista numerada
function addWordToList(text) {
  wordCounter++;
  currentWordEl.textContent = text;

  setTimeout(() => {
    const item = document.createElement('div');
    item.className = 'word-item';
    item.textContent = `${wordCounter}) ${text}`;
    wordsListEl.appendChild(item);

    // Limpia el centro y vuelve a mostrar los puntos suspensivos
    currentWordEl.textContent = '';
    loader.style.display = 'block';
  }, 1000);
}

// Evento al presionar el boton para arrancar la pantalla
btnStart.addEventListener('click', async () => {
  try {
    // Solicitud explicita del microfono
    await navigator.mediaDevices.getUserMedia({ audio: true });

    btnStart.style.display = 'none';
    displayContainer.classList.add('active');

    isListening = true;
    recognition = initSpeech();

    if (recognition) {
      recognition.start();
    }
  } catch (err) {
    alert('Es necesario conceder permiso de microfono para usar la pantalla.');
  }
});