// Les valeurs de ce fichier partent sur le réseau ou dans le stockage local.
// Les traduire ne casse rien à la compilation et casse tout à l'exécution.

export type Status = 'draft' | 'published' | 'archived'

export enum Channel {
  Email = 'email',
  Push = 'push',
}

export const STORAGE_KEY = 'atelier:v3:brouillon'

export function route(message: { kind: 'sync' | 'reset' }): string {
  switch (message.kind) {
    case 'sync':
      return 'Synchronisation en cours'
    case 'reset':
      return 'Réinitialisation demandée'
  }
}

export function isArchived(s: Status): boolean {
  return s === 'archived'
}

export const CONTENT_TYPE = 'application/vnd.atelier+json'
