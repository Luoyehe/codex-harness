import type { useSettingsNavigation } from '../hooks/useSettingsDraft';
import { Dialog } from './Dialog';

export function SettingsDraftDialog({ navigation }: {
  navigation: ReturnType<typeof useSettingsNavigation>;
}) {
  return navigation.intent && (
    <Dialog title="放弃未保存的编辑？" onClose={navigation.cancel}>
      <p>{navigation.intent.detail}</p>
      <div className="inline wrap">
        <button className="button" onClick={navigation.cancel}>继续编辑</button>
        <button className="button danger" onClick={navigation.confirm}>{navigation.intent.label}</button>
      </div>
    </Dialog>
  );
}
