import type { CollectionConfig } from "payload";

export const Users: CollectionConfig = {
  slug: "users",
  auth: {
    maxLoginAttempts: 5,
    lockTime: 10 * 60 * 1000,
    tokenExpiration: 28800,
    cookies: {
      secure: process.env.NODE_ENV === "production",
      sameSite: "Lax",
    },
  },
  timestamps: true,
  admin: {
    useAsTitle: "email",
  },
  fields: [
    {
      name: "firstName",
      type: "text",
    },
    {
      name: "lastName",
      type: "text",
    },
    {
      name: "role",
      type: "select",
      required: true,
      defaultValue: "viewer",
      options: [
        { label: "Admin", value: "admin" },
        { label: "Analyst", value: "analyst" },
        { label: "Viewer", value: "viewer" },
      ],
    },
    {
      name: "isActive",
      type: "checkbox",
      defaultValue: true,
      required: true,
      admin: {
        description: "Deactivated users are barred from authenticating across all routes.",
      },
    },
    {
      name: "lastLogin",
      type: "date",
      admin: {
        description: "Timestamp of last successful authentication.",
      },
    },
  ],
};
