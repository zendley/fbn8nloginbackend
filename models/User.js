import mongoose from "mongoose";

const userSchema = new mongoose.Schema(
  {
    facebookId: { type: String, index: true },
    name: String,
    // long-lived user token (60 days)
    llUserToken: String,
    llUserTokenExpiresAt: Date
  },
  { timestamps: true }
);

export default mongoose.model("User", userSchema);