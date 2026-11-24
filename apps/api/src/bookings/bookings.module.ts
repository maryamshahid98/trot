import { Module } from '@nestjs/common';
import { AttendanceService } from './attendance.service.ts';
import { BookingsController, ClassLifecycleController, WaitlistController } from './bookings.controller.ts';
import { BookingsService } from './bookings.service.ts';
import { WaitlistService } from './waitlist.service.ts';

@Module({
  controllers: [BookingsController, WaitlistController, ClassLifecycleController],
  providers: [BookingsService, WaitlistService, AttendanceService],
})
export class BookingsModule {}
