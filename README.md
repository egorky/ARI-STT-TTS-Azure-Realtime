# Asterisk ARI y Azure Speech Service Integration

Este proyecto es una aplicación de Node.js que actúa como un puente entre un sistema de telefonía Asterisk y los servicios de voz de Microsoft Azure. Permite la síntesis de voz (TTS) y el reconocimiento de voz (STT) en tiempo real durante una llamada.

La aplicación se conecta a Asterisk a través de la interfaz ARI (Asterisk REST Interface) para controlar el flujo de la llamada.

## Arquitectura

1.  **Cliente ARI (`ari-client.js`):** Es el orquestador principal. Se conecta a Asterisk, gestiona los eventos de la llamada (`StasisStart`) y coordina todos los demás módulos.
2.  **Servicio de Azure (`azure-service.js`):** Encapsula toda la lógica para comunicarse con Microsoft Azure.
    *   **TTS:** Utiliza `SpeechSynthesizer` para convertir texto a un stream de audio.
    *   **STT:** Utiliza `SpeechRecognizer` con un `PushAudioInputStream` para enviar audio en tiempo real y recibir transcripciones.
3.  **Servidor RTP (`rtp-server.js`):** Se crea un servidor UDP para recibir el audio del llamante. Asterisk envía una copia del audio del canal a este servidor mediante un `externalMediaChannel`.
4.  **Conversor de Audio (`audio-converter.js`):** El audio de Asterisk llega en formato `ulaw`. Este módulo lo convierte a `PCM 16-bit`, que es el formato requerido por Azure para el reconocimiento.
5.  **Configuración (`config.js` y `.env`):** Toda la configuración es externa y se gestiona a través de variables de entorno, facilitando el despliegue en diferentes entornos.

## Flujo de la Llamada

1.  Una llamada llega a Asterisk y es dirigida a la aplicación Stasis (`speech-to-text-app`).
2.  La aplicación Node.js recibe el evento `StasisStart`.
3.  Se responde la llamada y se lee la variable de canal `TEXT_TO_SPEAK`.
4.  Se inicia el `AzureService` para la síntesis de ese texto. El audio resultante se reproduce en el canal del llamante.
5.  Paralelamente, se configura un "snoop" en el canal del llamante para obtener una copia de su audio.
6.  Este audio se envía a un servidor RTP local (dentro de la app de Node.js).
7.  El audio recibido se convierte de `ulaw` a `PCM` y se envía al servicio STT de Azure.
8.  Se utiliza la función `TALK_DETECT` de Asterisk para saber cuándo el usuario empieza y deja de hablar, controlando así cuándo se envía el audio a Azure.
9.  Una vez que Azure devuelve la transcripción final, se guarda en una variable de canal llamada `TRANSCRIPT`.
10. La llamada se devuelve al dialplan de Asterisk para que continúe su curso.

## Requisitos Previos

*   Node.js (v14 o superior)
*   Una instancia de Asterisk (v16 o superior) con el módulo ARI habilitado.
*   Una cuenta de Microsoft Azure con una suscripción a los servicios de voz (Speech Service).

## Instalación y Ejecución

1.  **Clonar el repositorio:**
    ```bash
    git clone <URL_DEL_REPOSITORIO>
    cd <NOMBRE_DEL_DIRECTORIO>
    ```

2.  **Instalar dependencias:**
    ```bash
    npm install
    ```

3.  **Configurar el entorno:**
    Crea un archivo `.env` a partir del ejemplo proporcionado:
    ```bash
    cp .env.example .env
    ```
    Edita el archivo `.env` y rellena todas las variables con tus datos de Asterisk y Azure. Asegúrate de que `EXTERNAL_MEDIA_SERVER_IP` sea la dirección IP de la máquina donde se ejecuta esta aplicación, y que sea accesible desde tu servidor Asterisk.

4.  **Configurar Asterisk:**
    *   **`ari.conf`**: Asegúrate de que ARI esté habilitado y configurado correctamente.
    *   **`extensions.conf`**: Necesitarás un dialplan que envíe la llamada a tu aplicación. Aquí tienes un ejemplo:
        ```ini
        [from-internal]
        exten => 1234,1,NoOp(Llamada a la aplicación de reconocimiento de voz)
        same => n,Answer()
        same => n,Set(TEXT_TO_SPEAK=Hola, bienvenido. Por favor, dígame qué necesita después del tono.)
        same => n,Stasis(speech-to-text-app)
        same => n,NoOp(La transcripción es: ${TRANSCRIPT})
        same => n,Hangup()
        ```
    *   **`func_talkdetect.conf`**: Asegúrate de que esta función esté disponible si quieres usar `TALK_DETECT`. La configuración se pasa desde la aplicación, por lo que no se necesita una configuración especial aquí.

5.  **Iniciar la aplicación:**
    ```bash
    npm start
    ```
    Si todo está configurado correctamente, verás un mensaje indicando que la aplicación se ha conectado a ARI y está lista para recibir llamadas.
