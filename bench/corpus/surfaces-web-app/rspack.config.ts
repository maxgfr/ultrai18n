// Le manifeste PWA n'existe qu'au moment de la compilation : `find -name
// manifest.json` ne renvoie rien et une recherche par nom de fichier rate
// l'intégralité de la fiche d'installation.
export default {
  output: { publicPath: '/atelier/' },
  plugins: [
    {
      manifest: {
        name: 'Atelier',
        short_name: 'Atelier',
        description: 'Un atelier de publication pour petites équipes',
        lang: 'fr',
        start_url: '/atelier/',
        theme_color: '#0b0f0e',
      },
    },
  ],
}
