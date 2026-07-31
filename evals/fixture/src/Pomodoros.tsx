export function Pomodoros({ done, est }: { done: number; est: number }) {
  const label = `${done} pomodoro${done > 1 ? 's' : ''} sur ${est} estimé`
  return (
    <ul aria-label={`Monter ${label} vers le haut`}>
      <li>Rien à faire pour le moment.</li>
      <button title="Fermer">OK</button>
    </ul>
  )
}
