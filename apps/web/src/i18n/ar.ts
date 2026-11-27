import type { Messages } from './en';

/** Sign-in and menu wording in Arabic. A draft for the club to review (BRD open decision OD-09). */
export const ar: Messages = {
  appName: 'Trot',
  nav: { dashboard: 'لوحة المتابعة', calendar: 'التقويم', bookings: 'الحجوزات', people: 'الأشخاص', horses: 'الخيول', staff: 'الموظفون', money: 'المالية', progress: 'التقدم', comms: 'الرسائل', reports: 'التقارير', admin: 'الإدارة', security: 'الأمان' },
  login: {
    title: 'تسجيل الدخول', subtitle: 'بوابة موظفي النادي', identifier: 'البريد الإلكتروني أو الهاتف', password: 'كلمة المرور', submit: 'دخول', working: 'جار الدخول…', staffOnly: 'هذه البوابة لموظفي النادي. يرجى استخدام تطبيق Trot.',
    failed: 'تعذر تسجيل الدخول. تحقق من بياناتك وحاول مرة أخرى.', tooMany: 'محاولات كثيرة. انتظر دقيقة ثم حاول مرة أخرى.', offline: 'تعذر الاتصال بالخادم.',
    codeTitle: 'أدخل الرمز', codeHelp: 'افتح تطبيق المصادقة وأدخل الرمز المكون من 6 أرقام.', code: 'الرمز', useRecovery: 'فقدت هاتفك؟ استخدم رمز الاسترداد', useApp: 'استخدم رمز التطبيق',
    recoveryCode: 'رمز الاسترداد', verify: 'متابعة', codeFailed: 'الرمز غير صحيح. جرب أحدث رمز.', expired: 'انتهت المهلة. سجل الدخول مرة أخرى.', back: 'البدء من جديد',
  },
  shell: { search: 'ابحث عن فارس بالاسم', searchLabel: 'البحث عن الفرسان', menu: 'القائمة', skip: 'انتقل إلى المحتوى', branch: 'الفرع', signOut: 'تسجيل الخروج', theme: 'تغيير المظهر', language: 'اللغة', loading: 'جار التحميل…' },
  page: { comingSoon: 'هذه الشاشة قيد الإعداد.', welcome: 'مرحبا', signedInAs: 'مسجل الدخول باسم' },
  roles: { director: 'مدير النادي', finance: 'المسؤول المالي', scheduler: 'منسق الجداول', auditor: 'مدقق', customer: 'عميل', coach: 'مدرب', stable_hand: 'مسؤول الإسطبل', reception: 'الاستقبال', manager: 'مدير', owner: 'المالك' },
  errors: { generic: 'حدث خطأ. حاول مرة أخرى.', session: 'انتهت الجلسة. سجل الدخول مرة أخرى.' },
};
