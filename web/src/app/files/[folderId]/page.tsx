"use client";

import { useParams } from "next/navigation";
import { Drive } from "@/components/Drive";

export default function FolderPage() {
  const { folderId } = useParams<{ folderId: string }>();
  return <Drive key={folderId} folderId={folderId} />;
}
