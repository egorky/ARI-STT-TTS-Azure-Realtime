'use strict';

module.exports = (sequelize, DataTypes) => {
  const Interaction = sequelize.define('Interaction', {
    uniqueId: {
      type: DataTypes.STRING,
      allowNull: false,
      comment: 'The unique ID of the call session from Asterisk.'
    },
    callerId: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: 'The caller ID number.'
    },
    textToSynthesize: {
      type: DataTypes.TEXT,
      allowNull: true,
      comment: 'The text that was sent to Azure for TTS.'
    },
    synthesizedAudioPath: {
        type: DataTypes.STRING,
        allowNull: true,
        comment: 'Path to the saved full audio file from TTS.'
    },
        sttAudioPath: {
            type: DataTypes.STRING,
            allowNull: true,
            comment: 'Path to the saved full audio file from user speech (STT).'
        },
    recognitionMode: {
        type: DataTypes.ENUM('VOICE', 'DTMF', 'NO_INPUT', 'TIMEOUT', 'ERROR'),
        allowNull: false,
        comment: 'The mode of input received from the user.'
    },
    transcript: {
      type: DataTypes.TEXT,
      allowNull: true,
      comment: 'The transcribed text from user speech.'
    },
    dtmfResult: {
        type: DataTypes.STRING,
        allowNull: true,
        comment: 'The DTMF digits entered by the user.'
    }
  }, {
    comment: 'Stores each interaction (a single Stasis app execution) within a call.'
  });

  return Interaction;
};
