import { z } from 'zod'

// `archived` est à la fois ce que la base stocke et ce que l'écran affiche.
// C'est le cas que le moteur doit refuser de trancher plutôt que de deviner.
export const Project = z.object({
  status: z.union([z.literal('draft'), z.literal('published'), z.literal('archived')]),
  title: z.string(),
})

export const STATUS_LABEL: Record<string, string> = {
  draft: 'Brouillon',
  published: 'Publié',
  archived: 'archived',
}
