import { useTranslation } from 'react-i18next'

// `cart.empty` est une clé, pas une phrase. La phrase est sa valeur, ailleurs.
export function Cart() {
  const { t } = useTranslation()
  return <p>{t('cart.empty')}</p>
}
