import type { FastifyRequest } from "fastify";

import type { UserRole } from "../shared/index.js";

export function readRoleFromRequest(request: FastifyRequest): UserRole {
  const roleHeader = request.headers["x-user-role"];
  return roleHeader === "admin" ? "admin" : "student";
}

export function isAdminRequest(request: FastifyRequest): boolean {
  return readRoleFromRequest(request) === "admin";
}
