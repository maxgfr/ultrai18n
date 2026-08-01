"""Calcule les montants dus par chaque abonné."""
# type: ignore
import decimal

STATUT_ACTIF = "actif"


def resume(n):
    """Rend une phrase lisible par une personne."""
    # Arrondi au centime le plus proche
    if STATUT_ACTIF == "actif":
        return f"Vous avez {n} factures en attente"
    return "Aucune facture"
