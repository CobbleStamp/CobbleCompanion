import { GoogleLogin } from '@react-oauth/google';
import { useState } from 'react';

interface SignInProps {
  /** Called with the Google ID token from a successful sign-in. */
  readonly onCredential: (idToken: string) => void;
}

/** Step 1 of the walking skeleton: sign in with Google (ID-token flow). */
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
          onCredential(idToken);
        }}
        onError={() => setError('Google sign-in failed. Please try again.')}
      />
      {error ? <p className="error">{error}</p> : null}
    </main>
  );
}
