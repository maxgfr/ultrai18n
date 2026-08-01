-- Table des abonnés et de leur statut de paiement
CREATE TABLE abonnes (
  id SERIAL PRIMARY KEY,
  statut TEXT NOT NULL DEFAULT 'actif',
  message TEXT DEFAULT 'Bienvenue parmi nous'
);
/* Index ajouté pour la recherche par statut */
CREATE INDEX ON abonnes (statut);
