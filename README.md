# Finance_Care mobile (Android)

Même application que la version PC, installable sur le téléphone (PWA), qui fonctionne hors ligne
et enregistre les **mêmes fichiers CSV** dans votre Dropbox (OneDrive reste possible en option).

## Comment ça marche

- L'application est une page web hébergée gratuitement (GitHub Pages). Une fois ouverte dans Chrome,
  « Ajouter à l'écran d'accueil » l'installe comme une vraie application, utilisable hors ligne.
- Les données ne passent **jamais** par GitHub : elles vont directement du téléphone à votre Dropbox.
- Connexion avec votre compte Dropbox. L'application Dropbox est de type « App folder » :
  accès **uniquement** au dossier `Dropbox/Applications/Finance_Care`. Elle ne peut pas voir le reste de votre Dropbox.
- Sur le PC, l'application Dropbox synchronise ce dossier : la version PC y lit et écrit ses CSV.
- Dans ce dossier : `comptes.csv` et `utilisateurs/<nom>/*.csv`, exactement comme le dossier `donnees/` du PC
  (vérifié par les tests : fichiers identiques octet pour octet).

## Nouveautés (version 2)

- **Plusieurs comptes bancaires** (courant, livret, compte joint…) : page « Comptes bancaires », et en haut des pages
  un sélecteur pour afficher un, deux, trois comptes ou tous. Fichier `comptes_bancaires.csv` + colonne `compte_id`
  dans `revenus.csv`, `depenses.csv`, `recurrentes.csv`. Les anciens fichiers sont relus sans rien perdre :
  tout ce qui n'a pas de compte va dans le « Compte principal ».
- **Mon compte** : prénom, devise, salaire (et compte de versement), nom d'utilisateur, mot de passe.
- **Suppression du compte** (nom d'utilisateur + mot de passe demandés) : efface l'identifiant et le dossier
  `utilisateurs/<nom>/` (Dropbox garde les fichiers supprimés environ 30 jours).
- **Téléphone** : barre d'onglets en bas, bouton « + », listes au lieu de tableaux, fenêtres qui montent du bas.

## Synchronisation

- Chaque modification est gardée tout de suite sur le téléphone, puis envoyée sur Dropbox
  (1,5 s après, ou au retour du réseau si vous êtes hors ligne).
- Seuls les fichiers modifiés sont envoyés.
- À l'ouverture de l'application, elle récupère ce qui a changé sur Dropbox (par exemple depuis le PC).
- **Conflit** : si le même fichier a été modifié sur le téléphone ET ailleurs depuis la dernière
  synchronisation, rien n'est écrasé : l'application demande quelle version garder.
- La pastille en bas à droite indique l'état (À jour, Envoi…, Hors ligne, Conflit, Reconnexion).

## Fichiers

| Fichier | Rôle |
|---|---|
| `index.html`, `app.js`, `calc.js`, `styles.css` | l'application (app.js est le même que sur PC, avec un petit point d'accroche) |
| `csvformat.js` | lecture/écriture des CSV (copie fidèle de server.js) |
| `sync.js` | connexion Dropbox (ou OneDrive) + synchronisation hors ligne |
| `config.js` | **à remplir** : la « App key » Dropbox (non secrète ; ne jamais y mettre l'« App secret ») |
| `sw.js`, `manifest.webmanifest`, `icons/` | installation sur le téléphone et fonctionnement hors ligne |
| `mobile.css` | ajustements pour téléphone |

## Tests

Depuis ce dossier, avec le dossier `finance_care` (version PC) à côté :
`node --test tests/mobile.test.js`
