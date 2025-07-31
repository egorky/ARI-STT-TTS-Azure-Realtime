# Detección de Voz (VAD) y Timeouts

Este documento explica en detalle cómo la aplicación maneja la detección de la voz del usuario y los mecanismos de timeout para asegurar un comportamiento robusto.

## 1. Detección de Actividad de Voz (VAD)

El VAD es el mecanismo que permite a la aplicación saber cuándo el usuario está hablando y cuándo ha dejado de hablar. En este proyecto, se utiliza la función `TALK_DETECT` nativa de Asterisk, que a su vez emite los eventos `ChannelTalkingStarted` y `ChannelTalkingFinished` en el bus de eventos de ARI.

### 1.1. Flujo de Activación del VAD

La activación del VAD es configurable para adaptarse a diferentes casos de uso:

-   **Modo `after_prompt_start` (con Barge-in)**:
    1.  La aplicación empieza a reproducir el primer chunk de audio del prompt.
    2.  Se inicia un temporizador (`VAD_ACTIVATION_DELAY_MS`).
    3.  Cuando el temporizador concluye, se habilita `TALK_DETECT` en el canal.
    4.  En este punto, la aplicación está simultáneamente reproduciendo el prompt y escuchando al usuario.

-   **Modo `after_prompt_end`**:
    1.  La aplicación reproduce todos los chunks de audio del prompt.
    2.  Solo cuando el último chunk ha terminado de reproducirse, se habilita `TALK_DETECT`.

### 1.2. Manejo de "Barge-in" (Interrupción)

El "Barge-in" es la capacidad del usuario de interrumpir el prompt hablando encima de él. Esto solo es posible en el modo `after_prompt_start`.

El flujo es el siguiente:
1.  El VAD está activo mientras el prompt se reproduce.
2.  El usuario empieza a hablar.
3.  La aplicación recibe el evento `ChannelTalkingStarted`.
4.  Al recibir este evento, la aplicación:
    -   **Detiene la reproducción del prompt**: Se detiene cualquier audio encolado en el puente de la llamada.
    -   **Limpia la cola de TTS**: Se vacía la cola interna de chunks de audio que quedaban por reproducir.
    -   **Inicia el reconocimiento**: Se abre la sesión con Azure y se empieza a procesar el audio del usuario.

### 1.3. Ignorar el Propio Audio del Prompt

Un desafío clave es evitar que el VAD se dispare con el audio del propio prompt. Esto se soluciona con una bandera de estado interna (`isPlayingPrompt`):

1.  La bandera se establece a `true` antes de que comience la reproducción del prompt.
2.  Si `ChannelTalkingStarted` se dispara mientras esta bandera es `true`, la aplicación sabe que es una interrupción del usuario y actúa como se describe en la sección de "Barge-in".
3.  La bandera se establece a `false` solo cuando el prompt ha terminado por completo (o ha sido interrumpido). A partir de este momento, cualquier evento `ChannelTalkingStarted` se considera el inicio del habla del usuario después del prompt.

*Nota: La implementación anterior ignoraba los eventos de VAD durante el prompt, lo cual era incorrecto. La lógica actual los usa como disparador para el barge-in.*

## 2. Timeouts (Temporizadores)

Los timeouts son cruciales para evitar que las llamadas se queden "colgadas" indefinidamente, consumiendo recursos.

### 2.1. Timeout de Sesión (`ARI_SESSION_TIMEOUT_MS`)

-   **Propósito**: Establecer un límite de tiempo máximo para toda la interacción del usuario con la aplicación ARI.
-   **Funcionamiento**:
    -   Se inicia un temporizador tan pronto como la llamada entra en la aplicación (`handleCall`).
    -   Si la llamada no ha terminado (colgado o devuelta al dialplan) antes de que este tiempo se agote, el temporizador se dispara.
    -   Al dispararse, ejecuta un `channel.hangup()` para forzar la finalización de la llamada.
    -   Si la llamada termina correctamente, este temporizador se cancela en la función `cleanup`.
-   **Cuándo usarlo**: Es una medida de seguridad general para cualquier llamada. Se recomienda un valor como 60-120 segundos.

### 2.2. Timeout de No-Input (`NO_INPUT_TIMEOUT_MS`)

-   **Propósito**: Limitar el tiempo que la aplicación espera a que el usuario hable después de que se le ha dado la oportunidad (es decir, después de que el prompt termina).
-   **Funcionamiento**:
    -   Se inicia un temporizador en el momento en que la aplicación está lista para que el usuario hable (en la función `enableTalkDetection`).
    -   Si el evento `ChannelTalkingStarted` se dispara (el usuario empieza a hablar), este temporizador se cancela inmediatamente.
    -   Si el temporizador se agota antes de que el usuario hable, se asume que no hay entrada y se ejecuta un `channel.hangup()` para terminar la llamada.
-   **Cuándo usarlo**: Esencial para evitar que las llamadas silenciosas (donde el usuario no responde) ocupen el sistema. Un valor típico es de 5 a 15 segundos.
