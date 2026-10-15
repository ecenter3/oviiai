import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { authConfig } from '../config';
import { OpLogModule } from '../oplog/oplog.module';
import { AuthController } from './auth.controller';
import { AuthRepository } from './auth.repository';
import { AUTH_CONFIG, AuthService } from './auth.service';
import { JwtAuthGuard } from './jwt-auth.guard';

@Module({
  imports: [
    JwtModule.registerAsync({
      useFactory: () => ({ secret: authConfig().jwtSecret, signOptions: { algorithm: 'HS256' }, verifyOptions: { algorithms: ['HS256'] } }),
    }),
    OpLogModule,
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    AuthRepository,
    { provide: AUTH_CONFIG, useFactory: authConfig },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
  ],
})
export class AuthModule {}
