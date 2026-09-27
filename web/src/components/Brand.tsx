/** The product's name beside Isar's mark. tokens.css picks the drawing for the theme. */
export default function Brand({ heading = false }: { heading?: boolean }) {
  const content = (
    <>
      <span className="brand-mark" role="img" aria-label="Isar" />
      Kunden Manager
    </>
  )
  return heading ? <h1 className="brand">{content}</h1> : <div className="brand">{content}</div>
}
