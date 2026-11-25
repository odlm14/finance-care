/* Finance_Care mobile — réglages.
 * clientId : « ID d'application (client) » de l'inscription faite sur le portail Microsoft (Azure / Entra).
 * Ce n'est PAS un secret : il identifie l'application, il ne donne accès à rien sans votre connexion. */
window.FC_CONFIG = {
  clientId: '',
  // Comptes Microsoft personnels (outlook.com, hotmail.com, live.com…).
  authority: 'https://login.microsoftonline.com/consumers',
};
