export function Cart({ n, files }: { n: number; files: number }) {
  // ultrai18n:plural count=n one="One item in your cart" other="{0} items in your cart"
  const label = `${n} item${n > 1 ? 's' : ''} in your cart`

  // No annotation here on purpose: the engine must still refuse this one rather
  // than read the forms off the ternary.
  const selection = `${files} file${files > 1 ? 's' : ''} selected`

  return (
    <section aria-label={label}>
      <p>{selection}</p>
      <button title="Empty the cart">Checkout</button>
    </section>
  )
}
