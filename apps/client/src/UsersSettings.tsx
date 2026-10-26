import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Plus, Trash2, Users } from 'lucide-react';
import type { SessionInfo, User } from '@openwebprint/shared';
import { api, post } from './api';
import { Modal, Spinner } from './ui';
import s from './App.module.css';
export function UsersSettings({
  session,
  changed,
}: {
  session: SessionInfo;
  changed: () => Promise<void>;
}) {
  const [users, setUsers] = useState<User[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const [passwordMessage, setPasswordMessage] = useState('');
  const [removing, setRemoving] = useState<User>();
  const load = useCallback(async () => setUsers(await api<User[]>('/users')), []);
  useEffect(() => {
    void load().catch((e) => setError(e.message));
  }, [load]);
  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
    setError('');
    if (data.get('password') !== data.get('confirmPassword')) {
      setError('Passwords do not match.');
      return;
    }
    setBusy(true);
    try {
      await post('/users', { username: data.get('username'), password: data.get('password') });
      form.reset();
      if (session.authenticationRequired) await load();
      await changed();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function changePassword(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
    setPasswordError('');
    setPasswordMessage('');
    if (data.get('newPassword') !== data.get('confirmNewPassword')) {
      setPasswordError('New passwords do not match.');
      return;
    }
    setBusy(true);
    try {
      await post('/account/password', {
        currentPassword: data.get('currentPassword'),
        newPassword: data.get('newPassword'),
      });
      form.reset();
      setPasswordMessage('Password changed. Other sessions have been signed out.');
    } catch (e) {
      setPasswordError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    if (!removing) return;
    setBusy(true);
    setError('');
    try {
      await api(`/users/${removing.id}`, { method: 'DELETE' });
      setUsers((existing) => existing.filter((user) => user.id !== removing.id));
      setRemoving(undefined);
      await changed();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className={s.settingsCard} aria-labelledby="users-title">
      <div className={s.settingsTitle}>
        <Users size={20} />
        <h2 id="users-title">Users</h2>
      </div>
      <p>
        {session.authenticationRequired
          ? 'Sign-in is enabled. All users can manage this instance and its devices.'
          : 'There are no users. This instance opens without signing in. Adding the first user enables sign-in for everyone.'}
      </p>
      {users.length > 0 && (
        <ul className={s.userList}>
          {users.map((user) => (
            <li key={user.id}>
              <span>
                {user.username}
                {user.id === session.user?.id && <small> (you)</small>}
              </span>
              <button
                className={s.iconButton}
                aria-label={`Remove user: ${user.username}`}
                onClick={() => setRemoving(user)}
                disabled={busy}
              >
                <Trash2 size={16} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={create} className={`${s.form} ${s.userForm}`}>
        <h3>Add user</h3>
        <label>
          Username
          <input name="username" autoComplete="off" required maxLength={80} disabled={busy} />
        </label>
        <div className={s.formGrid}>
          <label>
            Password
            <input
              name="password"
              type="password"
              autoComplete="new-password"
              required
              disabled={busy}
            />
          </label>
          <label>
            Confirm password
            <input
              name="confirmPassword"
              type="password"
              autoComplete="new-password"
              required
              disabled={busy}
            />
          </label>
        </div>
        {!session.authenticationRequired && (
          <p className={s.small}>You will be asked to sign in after creating this user.</p>
        )}
        {error && (
          <p className={s.error} role="alert">
            {error}
          </p>
        )}
        <button className={s.primary} disabled={busy}>
          {busy ? <Spinner /> : <Plus size={16} />} Add user
        </button>
      </form>
      {session.user && (
        <form
          onSubmit={changePassword}
          className={`${s.form} ${s.userForm}`}
          aria-labelledby="password-title"
        >
          <h3 id="password-title">Change your password</h3>
          <p>
            You will stay signed in here. All other sessions for your account will be signed out.
          </p>
          <label>
            Current password
            <input
              name="currentPassword"
              type="password"
              autoComplete="current-password"
              required
              disabled={busy}
            />
          </label>
          <div className={s.formGrid}>
            <label>
              New password
              <input
                name="newPassword"
                type="password"
                autoComplete="new-password"
                required
                disabled={busy}
              />
            </label>
            <label>
              Confirm new password
              <input
                name="confirmNewPassword"
                type="password"
                autoComplete="new-password"
                required
                disabled={busy}
              />
            </label>
          </div>
          {passwordError && (
            <p className={s.error} role="alert">
              {passwordError}
            </p>
          )}
          {passwordMessage && <p role="status">{passwordMessage}</p>}
          <button className={s.primary} disabled={busy}>
            {busy && <Spinner />} Change password
          </button>
        </form>
      )}
      {removing && (
        <Modal
          title="Remove user?"
          subtitle={removing.username}
          close={() => {
            if (!busy) setRemoving(undefined);
          }}
        >
          <div className={s.modalBody}>
            <p>
              {users.length === 1
                ? 'Removing the last user disables sign-in. Anyone who can reach this instance will be able to use it.'
                : 'This user will lose access and their active sessions will be revoked.'}
            </p>
            <div className={s.modalActions}>
              <button
                className={s.secondary}
                disabled={busy}
                onClick={() => setRemoving(undefined)}
              >
                Cancel
              </button>
              <button className={s.danger} disabled={busy} onClick={() => void remove()}>
                {busy ? <Spinner /> : <Trash2 size={16} />} Remove user
              </button>
            </div>
          </div>
        </Modal>
      )}
    </section>
  );
}
