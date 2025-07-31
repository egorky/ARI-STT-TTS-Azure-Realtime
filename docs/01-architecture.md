# Arquitectura de la Aplicación

Este documento describe la arquitectura general de la aplicación de integración entre Asterisk y Azure, detallando los componentes principales y el flujo de una llamada.

## 1. Descripción General

La aplicación actúa como un servicio de IVR (Respuesta de Voz Interactiva) inteligente que se conecta a Asterisk a través de ARI (Asterisk REST Interface). Su propósito es reproducir un audio de bienvenida (prompt), escuchar la respuesta del usuario, transcribirla usando los servicios de voz de Microsoft Azure y devolver el texto resultante al dialplan de Asterisk.

La arquitectura está diseñada para ser modular y robusta, manejando flujos de audio en tiempo real y gestionando el ciclo de vida de la llamada de forma segura.

## 2. Diagrama de Componentes

Este diagrama muestra los módulos principales de la aplicación y cómo interactúan entre sí y con los servicios externos.

```mermaid
graph TD
    subgraph "Servidor Node.js"
        A[index.js] --> B(ari-client.js);
        B --> C{azure-service.js};
        B --> D(rtp-server.js);
        B --> E(sound-manager.js);
        D --> F(audio-converter.js);
        E --> G(wav-helper.js);
        B --> H(logger.js);
        B --> I(config.js);
    end

    subgraph "Servicios Externos"
        J(Asterisk);
        K(Azure Speech Service);
    end

    B -- ARI (HTTPS) --> J;
    J -- RTP (UDP) --> D;
    C -- REST/WebSocket --> K;

    style A fill:#f9f,stroke:#333,stroke-width:2px;
    style B fill:#ccf,stroke:#333,stroke-width:2px;
```

-   **index.js**: Punto de entrada de la aplicación.
-   **ari-client.js**: Orquestador principal que maneja la lógica de la llamada.
-   **azure-service.js**: Encapsula toda la comunicación con los servicios de voz de Azure (TTS y STT).
-   **rtp-server.js**: Servidor UDP que recibe el audio del llamante desde Asterisk. Incluye un jitter buffer para reordenar paquetes.
-   **audio-converter.js**: Convierte el audio del formato `ulaw` (de Asterisk) a `PCM` (para Azure).
-   **sound-manager.js**: Gestiona la creación y limpieza de archivos de audio temporales (para streaming de TTS) y el guardado de grabaciones finales.
-   **wav-helper.js**: Utilidad para añadir cabeceras a archivos WAV.
-   **logger.js / config.js**: Módulos de utilidad para logging y configuración.

## 3. Diagrama de Secuencia de Llamada

Este diagrama ilustra el flujo de eventos y acciones durante una llamada típica, incluyendo el "barge-in" (cuando el usuario interrumpe el prompt).

```mermaid
sequenceDiagram
    participant Caller
    participant Asterisk
    participant App (ari-client.js)
    participant Azure (Speech Service)

    Caller->>Asterisk: Inicia llamada
    Asterisk->>App: Evento StasisStart
    App->>Asterisk: Answer()
    App->>Azure: Solicita TTS para el prompt

    Azure-->>App: Empieza a enviar chunks de audio (TTS)

    loop Para cada chunk de audio
        App->>App: Guarda chunk como .wav temporal
        App->>Asterisk: Playback(chunk.wav)
    end

    App->>App: Habilita TALK_DETECT
    Note right of App: El VAD está activo. Si el usuario habla, se detectará.

    Caller->>Asterisk: Empieza a hablar (Barge-in)
    Asterisk->>App: Evento ChannelTalkingStarted

    App->>App: Detiene la reproducción del prompt
    App->>App: Inicia sesión de reconocimiento (STT)
    App->>Azure: Envía audio del pre-buffer

    activate App
    Note right of App: Empieza a enviar audio en tiempo real del llamante a Azure

    Caller->>Asterisk: Continúa hablando
    Asterisk-->>App: Stream de audio RTP
    App-->>Azure: Stream de audio PCM

    Azure-->>App: Transcripción parcial (recognizing)

    Caller->>Asterisk: Deja de hablar
    Asterisk->>App: Evento ChannelTalkingFinished

    App->>Azure: Detiene el envío de audio
    deactivate App

    Azure-->>App: Transcripción final (recognized)

    App->>Asterisk: Set(TRANSCRIPT=...)
    App->>Asterisk: ContinueInDialplan()

    Asterisk->>Caller: Continúa o cuelga según el dialplan
```
