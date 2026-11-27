import { given, numberOrNull, textOrNull } from '../../lib/form';
import type { FieldDef, Values } from '../../ui/FormDialog';

/** The details a rider record holds beyond name and birth date (CUS-003). */
export const RIDER_ABOUT_FIELDS: FieldDef[] = [
  { name: 'phone', label: 'Rider’s phone', type: 'tel' }, { name: 'email', label: 'Rider’s email', type: 'email' },
  { name: 'heightCm', label: 'Height (cm)', type: 'number', min: 50 }, { name: 'weightKg', label: 'Weight (kg)', type: 'number', min: 10, hint: 'Needed before a horse with a weight limit can be assigned.' },
  { name: 'ridingExperience', label: 'Riding experience', type: 'textarea' }, { name: 'preferences', label: 'Preferences', type: 'textarea' }, { name: 'restrictions', label: 'Restrictions', type: 'textarea' },
];
export const RIDER_ABOUT_KEYS = ['phone', 'email', 'heightCm', 'weightKg', 'ridingExperience', 'preferences', 'restrictions'] as const;

const about = (v: Values) => ({
  phone: textOrNull(v.phone), email: textOrNull(v.email), heightCm: numberOrNull(v.heightCm), weightKg: numberOrNull(v.weightKg),
  ridingExperience: textOrNull(v.ridingExperience), preferences: textOrNull(v.preferences), restrictions: textOrNull(v.restrictions),
});
export const aboutForUpdate = about;
export const aboutForCreate = (v: Values) => given(about(v));
