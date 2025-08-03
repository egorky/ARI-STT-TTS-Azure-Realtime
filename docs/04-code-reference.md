# Referencia de la API del Código

Este documento proporciona una descripción detallada de cada archivo y función dentro del código fuente del proyecto.

---

## 1. `index.js`

-   **Propósito**: Punto de entrada principal de la aplicación.
-   **Descripción**: Este archivo es responsable de inicializar la configuración, instanciar la clase principal `App` y arrancar la aplicación. También gestiona el apagado ordenado (`graceful shutdown`) al capturar la señal `SIGINT` (Ctrl+C).

---

## 2. `config.js`

-   **Propósito**: Centralizar y exportar toda la configuración de la aplicación.
-   **Descripción**: Utiliza la librería `dotenv` para cargar variables de entorno desde un archivo `.env`. Proporciona un objeto `config` anidado que contiene toda la configuración de ARI, Azure, VAD, timeouts y RTP. Realiza una validación básica para asegurar que las credenciales de Azure estén presentes.

---

## 3. `logger.js`

-   **Propósito**: Proporcionar un sistema de logging flexible y contextualizado.
-   **Descripción**: Exporta una función `createLogger` que genera una instancia de logger. Esta instancia puede tener un contexto (como `uniqueId` y `callerId`) y una configuración específica. Esto permite que cada llamada tenga su propio logger con un nivel de log que puede ser sobrescrito desde el dialplan. El nivel de log se evalúa dinámicamente en cada llamada a un método de log (`debug`, `info`, `warn`, `error`).

---

## 4. `ari-client.js`

-   **Propósito**: Orquestador principal de la aplicación. Contiene toda la lógica de alto nivel para el manejo de llamadas.

### `class App`

-   **`constructor()`**: Inicializa las propiedades de la clase, incluyendo un `Map` para las llamadas activas (`activeCalls`).

-   **`start()`**:
    -   **Descripción**: Inicia la aplicación. Se conecta a ARI, registra los manejadores de eventos principales (`StasisStart`, `StasisEnd`) y pone la aplicación en modo de escucha. Los canales creados internamente (snoop, etc.) se marcan con `appArgs: 'internal'` para ser ignorados por el listener `StasisStart`.
    -   **Retorna**: `Promise<void>`

-   **`getDialplanVariables(channel, logger)`**:
    -   **Descripción**: Obtiene todas las variables de canal de Asterisk. Intenta usar `getChannelVars` y, si falla, recurre a un método manual para variables predefinidas.
    -   **Retorna**: `Promise<object>`

-   **`createCallConfig(dialplanVars, logger)`**:
    -   **Descripción**: Crea una configuración específica para la llamada actual. Clona la configuración global y la sobrescribe con cualquier variable `APP_VAR_*` encontrada en el dialplan. Contiene la lógica para parsear correctamente los valores (string, integer, boolean).
    -   **Retorna**: `object` - El objeto de configuración final para la llamada.

-   **`handleCall(channel)`**:
    -   **Descripción**: Es el corazón de la lógica de una llamada individual. Se ejecuta para cada nueva llamada. Gestiona todo el ciclo de vida:
        1. Obtiene las variables del dialplan.
        2. Crea una configuración y un logger específicos para la llamada.
        3. Responde la llamada, configura timeouts, y prepara el `callState`.
        4. Inicia el snooping de audio y el manejo del prompt.
    -   **Parámetros**: `channel` (object - Cliente ARI)
    -   **Retorna**: `Promise<void>`

-   **`setupStt(callState)`**:
    -   **Descripción**: Prepara el servicio de reconocimiento de voz de Azure. Inicia la sesión de reconocimiento continuo y configura los listeners para los eventos de `recognitionEnded` y `recognitionError`. Crea y devuelve una promesa que se resuelve con el `pushStream` cuando está listo.
    -   **Parámetros**: `callState` (object)
    -   **Retorna**: `Promise<PushAudioInputStream>`

-   **`setupAudioSnooping(callState)`**:
    -   **Descripción**: Configura la "escucha" del audio del llamante. Crea el servidor RTP, los puentes necesarios, el canal de snoop y el canal de media externo para desviar una copia del audio del llamante al servidor RTP local.
    -   **Parámetros**: `callState` (object)
    -   **Retorna**: `Promise<void>`

-   **`handlePrompt(callState, textToSpeak)`**:
    -   **Descripción**: Orquesta el manejo del prompt inicial según el `PROMPT_MODE` configurado. Llama a `playFileAudio` o `streamTtsAudio`.
    -   **Parámetros**: `callState` (object), `textToSpeak` (string)

-   **`playFileAudio(callState)`**:
    -   **Descripción**: Reproduce un archivo de audio pregrabado como prompt.
    -   **Parámetros**: `callState` (object)

-   **`streamTtsAudio(callState, text)`**:
    -   **Descripción**: Gestiona la reproducción del prompt en modo streaming desde Azure TTS. Recibe chunks de audio, los guarda como archivos temporales, los encola para su reproducción en ARI y los limpia después. También gestiona la lógica para el "barge-in".
    -   **Parámetros**: `callState` (object), `text` (string)

-   **`enableTalkDetection(callState)`**:
    -   **Descripción**: Activa la detección de voz. Inicia el pre-buffering de RTP, el temporizador de no-input y registra los listeners para `ChannelTalkingStarted`, `ChannelTalkingFinished` y `ChannelDtmfReceived`.
    -   **Parámetros**: `callState` (object)

-   **`saveInteraction(callState)`**:
    -   **Descripción**: Guarda la información de la interacción (transcripción, audio, etc.) en la base de datos.
    -   **Parámetros**: `callState` (object)

-   **`continueInDialplan(callState)`**:
    -   **Descripción**: Guarda los resultados finales (voz o DTMF) y devuelve el control al dialplan de Asterisk. Establece las variables `TRANSCRIPT` o `DTMF_RESULT`, y `RECOGNITION_MODE`.
    -   **Parámetros**: `callState` (object)
    -   **Retorna**: `Promise<void>`

-   **`cleanup(callState)`**:
    -   **Descripción**: Función de limpieza crucial. Se asegura de que todos los recursos asociados a una llamada (temporizadores, listeners, canales, puentes) se destruyan y liberen correctamente para prevenir fugas de memoria.
    -   **Parámetros**: `callState` (object)
    -   **Retorna**: `Promise<void>`

---

## 5. `azure-service.js`

-   **Propósito**: Encapsular toda la interacción con el SDK de Azure Speech.

### `class AzureService`

-   **`constructor(config)`**: Inicializa el `SpeechConfig` con las credenciales y la configuración de lenguaje/voz de Azure.

-   **`synthesizeText(text)`**:
    -   **Descripción**: Sintetiza un texto a un stream de audio.
    -   **Parámetros**: `text` (string)
    -   **Retorna**: `Promise<PassThrough>` - Un stream de Node.js que emite los chunks de audio PCM.

-   **`startContinuousRecognition()`**:
    -   **Descripción**: Inicia una sesión de reconocimiento de voz continuo. Especifica el formato de audio esperado (8kHz, 16-bit, mono) y configura los callbacks para los eventos del reconocedor (`recognizing`, `recognized`, `canceled`, `sessionStopped`).
    -   **Emite**: `audioStreamReady` (con el `pushStream`), `recognitionEnded` (con el texto final).

-   **`stopContinuousRecognition()`**:
    -   **Descripción**: Detiene la sesión de reconocimiento de voz y cierra los recursos asociados.

---

## 6. `rtp-server.js`

-   **Propósito**: Recibir y procesar el stream de audio RTP desde Asterisk.

### `class RtpServer`

-   **`constructor()`**: Inicializa el socket UDP y los listeners de eventos del socket.

-   **`listen(ip, startPort)`**:
    -   **Descripción**: Inicia el servidor en un puerto UDP. Si el puerto está en uso, intenta el siguiente.
    -   **Retorna**: `Promise<object>` - Resuelve con la dirección y puerto en el que está escuchando.

-   **`startPlayback()`**:
    -   **Descripción**: Inicia el bucle del Jitter Buffer. Cada 20ms, comprueba si ha llegado el siguiente paquete esperado y lo emite. Incluye lógica para saltar paquetes perdidos y evitar bloqueos.

-   **`startPreBuffering(bufferSize)`**:
    -   **Descripción**: Activa el modo de pre-buffering. Empieza a llenar un buffer circular con los paquetes RTP entrantes.
    -   **Parámetros**: `bufferSize` (number)

-   **`stopPreBufferingAndFlush()`**:
    -   **Descripción**: Desactiva el modo de pre-buffering y devuelve todo el audio almacenado como un único `Buffer`.
    -   **Retorna**: `Buffer`

-   **`close()`**:
    -   **Descripción**: Detiene el bucle del Jitter Buffer y cierra el socket UDP.

---

## 7. `audio-converter.js`

-   **Propósito**: Convertir formatos de audio.

-   **`ulawToPcm(ulawAudioBuffer)`**:
    -   **Descripción**: Convierte un `Buffer` de audio en formato G.711 u-law a un `Buffer` de audio en formato PCM lineal de 16 bits.
    -   **Parámetros**: `ulawAudioBuffer` (Buffer)
    -   **Retorna**: `Buffer`

---

## 8. `sound-manager.js`

-   **Propósito**: Gestionar archivos de audio temporales y permanentes.

-   **`initialize()`**:
    -   **Descripción**: Se asegura de que el directorio para los archivos de audio temporales (`/tmp/ari-tts-cache`) exista.

-   **`saveTempAudio(pcmAudioBuffer)`**:
    -   **Descripción**: Guarda un chunk de audio PCM en un archivo `.wav` temporal, añadiéndole la cabecera WAV necesaria.
    -   **Parámetros**: `pcmAudioBuffer` (Buffer)
    -   **Retorna**: `Promise<object>` - Resuelve con la ruta del archivo y el URI de sonido para ARI.

-   **`cleanupTempAudio(filePath)`**:
    -   **Descripción**: Elimina un archivo de audio temporal.

-   **`saveFinalAudio(audioBuffer, identifier)`**:
    -   **Descripción**: Guarda el audio completo de un prompt en el directorio `./recordings` para archivado.
    -   **Parámetros**: `audioBuffer` (Buffer), `identifier` (string)

---

## 9. `wav-helper.js`

-   **Propósito**: Crear cabeceras de archivo WAV válidas.

-   **`addWavHeader(pcmData, options)`**:
    -   **Descripción**: Toma datos PCM crudos y les antepone una cabecera WAV de 44 bytes correctamente formateada, resultando en un `Buffer` que representa un archivo `.wav` completo y válido.
    -   **Parámetros**: `pcmData` (Buffer), `options` (object con `numChannels`, `sampleRate`, `bitDepth`)
    -   **Retorna**: `Buffer`
