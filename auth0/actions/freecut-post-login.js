/**
 * Add this Post Login Action to the Login flow in Auth0 Dashboard.
 * User role is the default; ADMIN must be assigned explicitly in Auth0.
 */
exports.onExecutePostLogin = async (event, api) => {
  if (event.user.email_verified !== true) {
    api.access.deny('Debes verificar tu correo electrónico antes de usar FreeCut.')
    return
  }

  const namespace = 'https://freecut.cincodadosrojos3d.cl/'
  const assignedRoles = event.authorization?.roles ?? []
  const roles = assignedRoles.includes('ADMIN') ? ['USER', 'ADMIN'] : ['USER']

  api.accessToken.setCustomClaim(`${namespace}email_verified`, true)
  api.accessToken.setCustomClaim(`${namespace}roles`, roles)
}
