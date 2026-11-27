import { z } from 'zod';
import { LIMITS } from '../config/constants.ts';

export const LoginBody = z.object({
  identifier: z.string().trim().min(LIMITS.identifierMin).max(LIMITS.identifierMax), // email or phone
  password: z.string().min(1).max(LIMITS.passwordMax),
});
export const RefreshBody = z.object({ refreshToken: z.string().min(LIMITS.refreshTokenMin).max(LIMITS.refreshTokenMax) });
export const ChangePasswordBody = z
  .object({
    currentPassword: z.string().min(1).max(LIMITS.passwordMax),
    newPassword: z.string().min(LIMITS.newPasswordMin, `must be at least ${LIMITS.newPasswordMin} characters`).max(LIMITS.newPasswordMax),
  })
  .refine((v) => v.newPassword !== v.currentPassword, { message: 'must be different from the current password', path: ['newPassword'] });

export const ForgotBody = z.object({ identifier: z.string().trim().min(LIMITS.identifierMin).max(LIMITS.identifierMax) });
export const ResetBody = ForgotBody.extend({
  code: z.string().trim().regex(/^\d{6}$/, 'must be the 6 digits you were sent'),
  newPassword: z.string().min(LIMITS.newPasswordMin, `must be at least ${LIMITS.newPasswordMin} characters`).max(LIMITS.newPasswordMax),
});
