import { useState } from 'react'

export function DataSection() {
  const [toast, setToast] = useState('')
  return (
    <section>
      <button onClick={() => setToast('Données effacées.')}>Oui, tout effacer</button>
      {toast ? <p role="status">{toast}</p> : null}
    </section>
  )
}
