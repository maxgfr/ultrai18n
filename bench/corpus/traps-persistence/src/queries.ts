// Deux langages embarqués dans des gabarits. Chaque identifiant à l'intérieur
// appartient au serveur, pas à l'interface.
const gql = String.raw
const sql = String.raw

export const PROJECTS = gql`
  query Projects($status: Status!) {
    projects(status: $status) {
      id
      title
      publishedAt
    }
  }
`

export const RECENT = sql`
  SELECT id, title, published_at
  FROM projects
  WHERE status = 'published'
  ORDER BY published_at DESC
`

export const EMPTY_STATE = 'Aucun projet pour le moment'
