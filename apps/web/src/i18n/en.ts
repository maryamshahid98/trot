/** All words the person sees. Arabic is added as ar.ts with the same keys, and nothing else has to change. */
export const en = {
  appName: 'Trot',
  nav: {
    dashboard: 'Dashboard', calendar: 'Calendar', bookings: 'Bookings', people: 'People', horses: 'Horses',
    staff: 'Staff', money: 'Money', progress: 'Progress', comms: 'Comms', reports: 'Reports', admin: 'Admin', security: 'Security',
  },
  login: {
    title: 'Sign in', subtitle: 'Club staff portal', identifier: 'Email or phone', password: 'Password',
    submit: 'Sign in', working: 'Signing in…', staffOnly: 'This portal is for club staff. Please use the Trot app.',
    failed: 'Sign-in failed. Check your details and try again.', tooMany: 'Too many attempts. Wait a minute and try again.',
    offline: 'Cannot reach the server. Check that the API is running.',
    codeTitle: 'Enter your code', codeHelp: 'Open your authenticator app and enter the 6-digit code for Trot.', code: 'Code', useRecovery: 'Lost your phone? Use a recovery code', useApp: 'Use the app code instead',
    recoveryCode: 'Recovery code', verify: 'Continue', codeFailed: 'That code is not right. Try the newest code, or use a recovery code.', expired: 'That took too long. Please sign in again.', back: 'Start again',
  },
  shell: {
    search: 'Search riders by name', searchLabel: 'Search riders', menu: 'Menu', skip: 'Skip to content', branch: 'Branch', signOut: 'Sign out', theme: 'Change theme',
    language: 'Language', loading: 'Loading…',
  },
  page: { comingSoon: 'This screen is built next.', welcome: 'Welcome', signedInAs: 'Signed in as' },
  roles: { customer: 'Customer', coach: 'Coach', stable_hand: 'Stable hand', reception: 'Reception', manager: 'Manager', owner: 'Owner' },
  errors: { generic: 'Something went wrong. Please try again.', session: 'Your session ended. Please sign in again.' },
} as const;

export type Messages = typeof en;
