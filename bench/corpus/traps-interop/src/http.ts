// Les en-têtes HTTP sont un vocabulaire partagé avec des serveurs qui ne lisent
// pas le français. Les colonnes d'export le sont avec les tableurs des clients.

export const HEADERS = {
  'Content-Type': 'application/json',
  'X-Requested-With': 'XMLHttpRequest',
  'Accept-Language': 'fr-FR',
}

export const CSV_COLUMNS = ['email', 'nom', 'statut', 'inscrit_le']

export const EXPORT_BUTTON = 'Exporter les abonnés'
