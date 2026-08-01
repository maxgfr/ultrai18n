// Un vocabulaire ARIA, des classes CSS et des motifs de date : trois familles de
// chaînes qui ressemblent à de la langue et n'en sont pas.
export function Toolbar({ busy }: { busy: boolean }) {
  return (
    <div className="toolbar toolbar--compact" role="toolbar" aria-orientation="horizontal">
      <span aria-live="polite" aria-atomic="true">
        {busy ? 'Enregistrement en cours' : 'Toutes les modifications sont enregistrées'}
      </span>
      <button className="btn btn-primary" type="submit" aria-pressed="false">
        Publier
      </button>
    </div>
  )
}

export const DATE_FORMATS = {
  short: 'dd/MM/yyyy',
  long: "EEEE d MMMM yyyy 'à' HH:mm",
  iso: 'yyyy-MM-dd',
}
