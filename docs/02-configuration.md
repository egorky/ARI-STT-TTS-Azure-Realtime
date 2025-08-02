# Guía de Configuración

Toda la configuración de la aplicación se gestiona a través de variables de entorno, que se pueden definir en un archivo `.env` en la raíz del proyecto.

## 1. Configuración de Asterisk ARI

Estas variables definen la conexión con la interfaz ARI de tu servidor Asterisk.

-   **`ARI_URL`**
    -   **Descripción**: La URL completa del servidor ARI.
    -   **Ejemplo**: `http://127.0.0.1:8088`

-   **`ARI_USERNAME`**
    -   **Descripción**: El nombre de usuario para autenticarse con ARI.
    -   **Ejemplo**: `asterisk`

-   **`ARI_PASSWORD`**
    -   **Descripción**: La contraseña para el usuario de ARI.
    -   **Ejemplo**: `asterisk`

-   **`ARI_APP_NAME`**
    -   **Descripción**: El nombre de la aplicación Stasis que se registrará en Asterisk. Tu dialplan debe hacer referencia a este nombre.
    -   **Ejemplo**: `speech-to-text-app`

## 2. Configuración de Azure Speech Service

Credenciales para el servicio de voz de Microsoft Azure.

-   **`AZURE_SPEECH_SUBSCRIPTION_KEY`**
    -   **Descripción**: La clave de suscripción de tu recurso de Azure Speech.
    -   **Ejemplo**: `tu_clave_de_suscripcion_aqui`

-   **`AZURE_SPEECH_REGION`**
    -   **Descripción**: La región de tu recurso de Azure Speech.
    -   **Ejemplo**: `westus`, `eastus`

## 3. Configuración de Text-to-Speech (TTS)

Parámetros para la síntesis de voz (la voz de la aplicación).

-   **`AZURE_TTS_LANGUAGE`**
    -   **Descripción**: El código de lenguaje para la síntesis de voz.
    -   **Ejemplo**: `es-ES`, `en-US`

-   **`AZURE_TTS_VOICE_NAME`**
    -   **Descripción**: El nombre de la voz específica que se usará para la síntesis. Debe ser compatible con el lenguaje seleccionado.
    -   **Ejemplo**: `es-ES-ElviraNeural`

-   **`AZURE_TTS_OUTPUT_FORMAT`**
    -   **Descripción**: El formato del audio que se solicitará a Azure. Debe ser un formato PCM compatible con Asterisk.
    -   **Valor recomendado**: `Riff8Khz16BitMonoPcm`

## 4. Configuración de Speech-to-Text (STT)

Parámetros para el reconocimiento de voz (lo que el usuario dice).

-   **`AZURE_STT_LANGUAGE`**
    -   **Descripción**: El código de lenguaje que se espera que el usuario hable.
    -   **Ejemplo**: `es-ES`, `en-US`

## 5. Comportamiento de la Aplicación

Variables que controlan la lógica interna de la aplicación.

### Detección de Actividad de Voz (VAD)

-   **`VAD_ACTIVATION_MODE`**
    -   **Descripción**: Define cuándo se activa la detección de voz (`TALK_DETECT`).
    -   **Valores posibles**:
        -   `after_prompt_start`: Se activa después de que el primer chunk de audio del prompt empiece a reproducirse (permite "barge-in").
        -   `after_prompt_end`: Se activa solo después de que todo el prompt haya terminado de reproducirse.
    -   **Default**: `after_prompt_start`

-   **`VAD_ACTIVATION_DELAY_MS`**
    -   **Descripción**: Si `VAD_ACTIVATION_MODE` es `after_prompt_start`, este es el retardo en milisegundos que se espera antes de activar el VAD. Útil para evitar que se detecte el "click" de la respuesta de la llamada.
    -   **Ejemplo**: `500`

### Parámetros de `TALK_DETECT`

-   **`TALK_DETECT_SILENCE_THRESHOLD`**
    -   **Descripción**: La cantidad de silencio en milisegundos después de que el usuario deja de hablar para que se dispare el evento `ChannelTalkingFinished`.
    -   **Ejemplo**: `1200`

-   **`TALK_DETECT_SPEECH_THRESHOLD`**
    -   **Descripción**: La duración mínima de habla (en milisegundos) para que se considere una detección válida y se dispare `ChannelTalkingStarted`.
    -   **Ejemplo**: `500`

### Timeouts

-   **`ARI_SESSION_TIMEOUT_MS`**
    -   **Descripción**: El tiempo máximo en milisegundos que una sesión ARI puede durar en total. Si se excede, la llamada se colgará automáticamente. `0` para deshabilitar.
    -   **Ejemplo**: `60000` (1 minuto)

-   **`NO_INPUT_TIMEOUT_MS`**
    -   **Descripción**: El tiempo máximo en milisegundos que la aplicación esperará a que el usuario empiece a hablar después de que el prompt termine. Si se excede, la llamada se colgará. `0` para deshabilitar.
    -   **Ejemplo**: `10000` (10 segundos)

## 6. Configuración de Audio y RTP

Parámetros relacionados con el flujo de audio desde Asterisk.

-   **`RTP_PREBUFFER_SIZE`**
    -   **Descripción**: El número de paquetes de audio RTP que se almacenan en el pre-buffer para capturar el inicio del habla del usuario antes de que el VAD se dispare. Cada paquete suele ser de 20ms.
    -   **Ejemplo**: `100` (aproximadamente 2 segundos de audio)

-   **`EXTERNAL_MEDIA_SERVER_IP`**
    -   **Descripción**: La dirección IP de la máquina donde se ejecuta esta aplicación Node.js. Debe ser accesible desde el servidor Asterisk.
    -   **Ejemplo**: `127.0.0.1`

-   **`EXTERNAL_MEDIA_SERVER_PORT`**
    -   **Descripción**: El puerto UDP inicial en el que el servidor RTP intentará escuchar. Si está ocupado, intentará el siguiente.
    -   **Ejemplo**: `16000`

-   **`EXTERNAL_MEDIA_AUDIO_FORMAT`**
    -   **Descripción**: El formato de audio que se solicitará a Asterisk para el `externalMediaChannel`. Debe coincidir con lo que espera el `audio-converter`.
    -   **Valor recomendado**: `ulaw`

## 7. Configuración de DTMF

Parámetros para la detección de tonos de teclado (DTMF).

-   **`ENABLE_DTMF`**
    -   **Descripción**: Habilita o deshabilita la detección de DTMF. Si está habilitado, la aplicación puede capturar dígitos del teclado además del reconocimiento de voz.
    -   **Valores**: `true`, `false`
    -   **Default**: `true`

-   **`DTMF_COMPLETION_TIMEOUT_MS`**
    -   **Descripción**: El tiempo en milisegundos que la aplicación esperará después de que se presione el último dígito antes de considerar que la entrada está completa.
    -   **Ejemplo**: `2000`

## 8. Configuración de la Base de Datos

Parámetros para la conexión a la base de datos para registrar las interacciones.

-   **`DB_DIALECT`**
    -   **Descripción**: El dialecto de la base de datos a utilizar. Soportado por Sequelize.
    -   **Valores**: `sqlite`, `mysql`, `postgres`, etc.
    -   **Default**: `sqlite`

-   **`DB_STORAGE`**
    -   **Descripción**: Si se usa `sqlite`, esta es la ruta al archivo de la base de datos.
    -   **Ejemplo**: `./database/prod.sqlite`

-   **`DB_HOST`**, **`DB_PORT`**, **`DB_USER`**, **`DB_PASSWORD`**, **`DB_DATABASE`**
    -   **Descripción**: Credenciales de conexión estándar para bases de datos como MySQL o PostgreSQL.
