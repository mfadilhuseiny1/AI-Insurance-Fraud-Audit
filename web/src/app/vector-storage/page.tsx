import { Suspense } from "react";
import VectorStorage from "@/components/vector-storage/VectorStorage";

export default function VectorStoragePage() {
  // the open index is read from the address, which needs a Suspense boundary on a static page
  return (
    <Suspense>
      <VectorStorage />
    </Suspense>
  );
}
