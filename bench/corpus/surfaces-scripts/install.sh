#!/bin/sh
# shellcheck disable=SC2086
# Installe les dépendances avant de démarrer le serveur
set -eu
npm install --production
echo "Terminé"
