// ADMIN gate for /admin/*. See bigdev/plans/cont/03-ADMIN-DASHBOARD.md §7.5 and Addendum A6 item 4.
//
// One guard rather than the usual authMiddleware -> role check chain, because every failure here must
// look identical: a missing token, a bad token, and a valid non-admin token all get 404. A 401 would
// confirm the surface exists, which is exactly what "404, not 403" is protecting against.
//
// The user is re-read from the DB on every request (userFromToken), so roles are always current and a
// revoke locks the session out on its very next request. Never bake roles into the JWT.

import type { FastifyRequest, FastifyReply } from 'fastify';
import { isAdmin } from '../config/roles.ts';
import { userFromToken } from '../services/auth.ts';
import { handleError } from '../utils/errorHandler.ts';

const notFound = (reply: FastifyReply): Promise<FastifyReply> => handleError(reply, 404, 'Not found', 'NOT_FOUND');

export const adminMiddleware = async (request: FastifyRequest, reply: FastifyReply): Promise<true | FastifyReply> => {
  const authHeader = request.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) return await notFound(reply);

  const token = authHeader.slice('Bearer '.length).trim();
  if (!token) return await notFound(reply);

  const user = await userFromToken(token);
  if (!user || !isAdmin(user.specialRoles)) return await notFound(reply);

  request.user = user;
  return true;
};
