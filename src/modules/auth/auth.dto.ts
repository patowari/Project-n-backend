import { Transform } from 'class-transformer'
import { IsEmail, IsIn, IsOptional, IsString, Length, MaxLength, MinLength } from 'class-validator'

const trim = () => Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))

export class SignUpDto {
  @trim() @IsString() @Length(2, 120) name: string
  @trim() @IsEmail() @MaxLength(254) email: string
  @IsString() @MaxLength(128) password: string
  @IsIn(['institution', 'supervision']) workspaceType: 'institution' | 'supervision'
  @trim() @IsString() @Length(2, 120) workspaceName: string
}

export class LoginDto {
  @trim() @IsEmail() @MaxLength(254) email: string
  @IsString() @MaxLength(128) password: string
}

export class EmailDto {
  @trim() @IsEmail() @MaxLength(254) email: string
}

export class TokenDto {
  @IsString() @Length(20, 200) token: string
}

export class ResetPasswordDto {
  @IsString() @Length(20, 200) token: string
  @IsString() @MaxLength(128) password: string
}

export class AcceptInviteDto {
  @IsOptional() @trim() @IsString() @Length(2, 120) name?: string
  @IsOptional() @IsString() @MaxLength(128) password?: string
}

export class ChangePasswordDto {
  @IsString() @MaxLength(128) current: string
  @IsString() @MinLength(1) @MaxLength(128) next: string
}

export class ChangeEmailDto {
  @trim() @IsEmail() @MaxLength(254) email: string
}
