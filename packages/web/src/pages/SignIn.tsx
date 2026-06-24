import { GoogleLogin } from '@react-oauth/google';
import { useState } from 'react';

interface SignInProps {
  /** Exchange the Google ID token for an app session. Resolves `true` on success;
   *  `false` if the API rejected the exchange, so this gate can show an error. */
  readonly onCredential: (idToken: string) => Promise<boolean>;
}

/** The sign-in gate: obtain a Google ID token, then hand it to the app-session
 *  exchange. Surfaces both a Google failure and an exchange rejection. */
export function SignIn({ onCredential }: SignInProps): JSX.Element {
  const [error, setError] = useState<string | null>(null);

  return (
    <main className="card">
      <h1>CobbleCompanion</h1>
      <p>Sign in to raise your companion.</p>
      <GoogleLogin
        onSuccess={(credentialResponse) => {
          const idToken = credentialResponse.credential;
          if (!idToken) {
            setError('Google did not return a credential. Please try again.');
            return;
          }
          setError(null);
          void onCredential(idToken).then((ok) => {
            if (!ok) setError('Sign-in could not be completed. Please try again.');
          });
        }}
        onError={() => setError('Google sign-in failed. Please try again.')}
      />
      {error ? <p className="error">{error}</p> : null}
    </main>
  );
}
