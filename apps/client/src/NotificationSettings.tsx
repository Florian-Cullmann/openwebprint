import { t } from './i18n';
import type { useJobNotifications } from './useJobNotifications';
import s from './App.module.css';

export function NotificationSettings({
  notifications,
}: {
  notifications: ReturnType<typeof useJobNotifications>;
}) {
  const { permission, enabled, enable, disable } = notifications;
  const message = {
    unsupported:
      'This browser does not support system notifications. Job updates remain available in the app.',
    insecure:
      'System notifications require HTTPS or localhost. Job updates remain available in the app.',
    denied:
      'Notifications are blocked. Change this site’s browser permissions to allow them. Job updates remain available in the app.',
    default:
      'System notifications are off. Your browser will ask for permission when you enable them.',
    granted: enabled
      ? 'System notifications are enabled for new jobs started in this browser.'
      : 'System notifications are off.',
    unavailable:
      'System notifications could not be displayed. Job updates remain available in the app; this can happen on mobile browsers.',
  }[permission];
  return (
    <>
      <p role="status">{t(message)}</p>
      <p>
        {t(
          'Keep the application open. Each tab follows only jobs started there, including demo jobs (marked Demo). Background updates may be delayed by your browser. No external push service is used.',
        )}
      </p>
      <p>
        {t(
          'Messages omit document and device names. Print completion is reported by the provider and does not confirm physical output.',
        )}
      </p>
      <p>
        {t(
          'Reloading, signing out, changing operating mode or changing this preference clears pending notifications. Enabling does not replay earlier jobs.',
        )}
      </p>
      <button
        className={s.secondary}
        onClick={() => (enabled ? disable() : void enable())}
        disabled={!enabled && !['default', 'granted', 'unavailable'].includes(permission)}
      >
        {enabled ? t('Disable notifications') : t('Enable notifications')}
      </button>
    </>
  );
}
