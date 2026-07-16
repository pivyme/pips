import jwt from 'jsonwebtoken';
import type { FastifyRequest, FastifyReply } from 'fastify';
import type { User } from '../../prisma/generated/client.js';
import { prismaQuery } from '../lib/prisma.ts';
import { JWT_SECRET } from '../config/main-config.ts';
import { handleError } from '../utils/errorHandler.ts';

interface JwtPayload {
  userId: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: User;
  }
}

export const authMiddleware = async (request: FastifyRequest, reply: FastifyReply): Promise<true | FastifyReply> => {
  // Check if Authorization header exists
  const authHeader = request.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return handleError(reply, 401, 'Missing or invalid authorization header', 'MISSING_AUTH_HEADER');
  }

  const token = authHeader.split(' ')[1];
  if (!token) {
    return handleError(reply, 401, 'Token not provided', 'TOKEN_MISSING');
  }

  // Dev-only review-harness bypass, gated on NODE_ENV !== 'production' + a matching TESTING_TOKEN.
  // Resolves to the oldest seeded user. Delete by grepping TESTING_TOKEN.
  if (process.env.NODE_ENV !== 'production' && process.env.TESTING_TOKEN && token === process.env.TESTING_TOKEN) {
    const devUser = await prismaQuery.user.findFirst({ orderBy: { createdAt: 'asc' } });
    if (devUser) {
      console.warn(`[TESTING_TOKEN] auth bypassed for ${request.method} ${request.url}`);
      request.user = devUser;
      return true;
    }
    return handleError(reply, 401, 'No dev user to resolve. Seed the DB or sign in once.', 'TESTING_TOKEN_NO_USER');
  }

  let authData: JwtPayload | null = null;
  try {
    authData = jwt.verify(token, JWT_SECRET) as JwtPayload;
  } catch (error) {
    console.log(`Token verification failed with error ${error}.`);
    return handleError(reply, 401, 'Invalid or expired token', 'INVALID_TOKEN', error as Error);
  }

  // Safety check: Ensure authData.userId exists and is valid
  if (!authData || !authData.userId || authData.userId === undefined || authData.userId === null) {
    return handleError(reply, 401, 'Invalid token payload - missing user ID', 'INVALID_TOKEN_PAYLOAD');
  }

  const user = await prismaQuery.user.findUnique({
    where: {
      id: authData.userId,
    },
  });

  if (!user) {
    return handleError(reply, 401, 'User not found', 'USER_NOT_FOUND');
  }

  request.user = user;
  return true;
};
