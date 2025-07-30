'use strict';

// Carga la configuración primero para asegurar que las variables de entorno
// estén disponibles para todos los módulos.
require('./config');
const logger = require('./logger');
const App = require('./ari-client');

const app = new App();

app.start().catch(err => {
    logger.error("Application failed to start:", err);
    process.exit(1);
});

// Graceful shutdown
process.on('SIGINT', () => {
    logger.info("Caught interrupt signal, shutting down...");
    // Aquí podrías agregar lógica de limpieza si es necesario,
    // aunque el manejo de la llamada ya limpia sus propios recursos.
    process.exit(0);
});
