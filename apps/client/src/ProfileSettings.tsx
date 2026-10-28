import { useEffect, useRef, useState } from 'react';
import type { AppliedProfile, ProfileInput, SettingsProfile } from '@openwebprint/shared';
import { api, post } from './api';
import s from './App.module.css';

export function ProfileSettings({
  deviceId,
  settings,
  disabled,
  setBusy,
  applied,
}: {
  deviceId: string;
  settings: Omit<ProfileInput, 'name'>;
  disabled: boolean;
  setBusy: (busy: boolean) => void;
  applied: (result: AppliedProfile) => void;
}) {
  const [profiles, setProfiles] = useState<SettingsProfile[]>([]);
  const [selected, setSelected] = useState('');
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const requestActive = useRef(false);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    void api<SettingsProfile[]>(`/devices/${deviceId}/profiles`, { signal: controller.signal })
      .then(setProfiles)
      .catch((e) => {
        if (!controller.signal.aborted) setError((e as Error).message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [deviceId, reload]);
  async function act(action: 'create' | 'update' | 'apply' | 'delete') {
    if (requestActive.current || disabled || loading) return;
    requestActive.current = true;
    setBusy(true);
    setError('');
    setMessage('');
    const path = `/devices/${deviceId}/profiles`;
    try {
      if (action === 'apply') {
        const result = await post<AppliedProfile>(`${path}/${selected}/apply`);
        applied(result);
        setMessage(`Applied “${result.profile.name}”.`);
      } else if (action === 'delete') {
        await api(`${path}/${selected}`, { method: 'DELETE' });
        setProfiles((current) => current.filter((profile) => profile.id !== selected));
        setSelected('');
        setName('');
        setMessage('Profile deleted.');
      } else {
        const profile = await api<SettingsProfile>(
          action === 'create' ? path : `${path}/${selected}`,
          {
            method: action === 'create' ? 'POST' : 'PUT',
            body: JSON.stringify({ ...settings, name: name.trim() }),
          },
        );
        setProfiles((current) =>
          action === 'create'
            ? [...current, profile]
            : current.map((item) => (item.id === profile.id ? profile : item)),
        );
        setSelected(profile.id);
        setName(profile.name);
        setMessage(
          action === 'create' ? 'Profile saved.' : 'Profile updated with the current settings.',
        );
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      requestActive.current = false;
      setBusy(false);
    }
  }
  return (
    <fieldset className={s.profileSettings} disabled={disabled || loading}>
      <legend>Settings profiles</legend>
      <p className={s.small}>
        Shared with everyone using this instance. Settings only; no documents.
      </p>
      <label>
        Saved profile
        <select
          value={selected}
          onChange={(e) => {
            setSelected(e.target.value);
            setName(profiles.find((profile) => profile.id === e.target.value)?.name ?? '');
            setError('');
            setMessage('');
          }}
        >
          <option value="">
            {loading
              ? 'Loading profiles…'
              : profiles.length
                ? 'Choose a profile'
                : 'No saved profiles'}
          </option>
          {profiles.map((profile) => (
            <option key={profile.id} value={profile.id}>
              {profile.name}
            </option>
          ))}
        </select>
      </label>
      <div className={s.profileActions}>
        <button
          type="button"
          className={s.secondary}
          disabled={!selected}
          onClick={() => void act('apply')}
        >
          Apply profile
        </button>
        <button
          type="button"
          className={s.textButton}
          disabled={!selected}
          onClick={() => void act('delete')}
        >
          Delete profile
        </button>
      </div>
      <label>
        Profile name
        <input
          value={name}
          maxLength={80}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.preventDefault();
          }}
          placeholder="e.g. Everyday documents"
        />
      </label>
      <div className={s.profileActions}>
        <button
          type="button"
          className={s.secondary}
          disabled={!name.trim()}
          onClick={() => void act('create')}
        >
          Save new profile
        </button>
        <button
          type="button"
          className={s.textButton}
          disabled={!selected || !name.trim()}
          onClick={() => void act('update')}
        >
          Update profile
        </button>
      </div>
      {message && (
        <p role="status" className={s.small}>
          {message}
        </p>
      )}
      {error && (
        <>
          <p role="alert" className={s.error}>
            {error}
          </p>
          <button
            type="button"
            className={s.textButton}
            onClick={() => setReload((value) => value + 1)}
          >
            Reload profiles
          </button>
        </>
      )}
    </fieldset>
  );
}
