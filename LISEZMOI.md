# Finance_Care mobile (Android)

Même application que la version PC, installable sur le téléphone (PWA), qui fonctionne hors ligne
et enregistre les **mêmes fichiers CSV** dans votre OneDrive.

## Comment ça marche

- L'application est une page web hébergée gratuitement (GitHub Pages). Une fois ouverte dans Chrome,
  « Ajouter à l'écran d'accueil » l'installe comme une vraie application, utilisable hors ligne.
- Les données ne passent **jamais** par GitHub : elles vont directement du téléphone à votre OneDrive.
- Connexion avec votre compte Microsoft. Permission demandée : `Files.ReadWrite.AppFolder`,
  c'est-à-dire **uniquement** le dossier `OneDrive/Applications/<nom de l'application>`.
  L'application ne peut pas voir le reste de votre OneDrive.
- Dans ce dossier : `comptes.csv` et `utilisateurs/<nom>/*.csv`, exactement comme le dossier `donnees/` du PC
  (vérifié par les tests : fichiers identiques octet pour octet).

## Synchronisation

- Chaque modification est gardée tout de suite sur le téléphone, puis envoyée sur OneDrive
  (1,5 s après, ou au retour du réseau si vous êtes hors ligne).
- Seuls les fichiers modifiés sont envoyés.
- À l'ouverture de l'application, elle récupère ce qui a changé sur OneDrive (par exemple depuis le PC).
- **Conflit** : si le même fichier a été modifié sur le téléphone ET ailleurs depuis la dernière
  synchronisation, rien n'est écrasé : l'application demande quelle version garder.
- La pastille en bas à droite indique l'état (À jour, Envoi…, Hors ligne, Conflit, Reconnexion).

## Fichiers

| Fichier | Rôle |
|---|---|
| `index.html`, `app.js`, `calc.js`, `styles.css` | l'application (app.js est le même que sur PC, avec un petit point d'accroche) |
| `csvformat.js` | lecture/écriture des CSV (copie fidèle de server.js) |
| `onedrive.js` | connexion Microsoft + OneDrive + synchronisation hors ligne |
| `config.js` | **à remplir** : l'identifiant d'application Microsoft (client ID, non secret) |
| `sw.js`, `manifest.webmanifest`, `icons/` | installation sur le téléphone et fonctionnement hors ligne |
| `mobile.css` | ajustements pour téléphone |

## Tests

Depuis ce dossier, avec le dossier `finance_care` (version PC) à côté :
`node --test tests/mobile.test.js`
