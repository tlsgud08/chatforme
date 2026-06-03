interface Props {
  name: string | null;
  avatarUrl: string | null;
  size?: 'sm' | 'md' | 'lg';
}

const sizes = { sm: 'h-9 w-9', md: 'h-12 w-12', lg: 'h-20 w-20' };
const textSizes = { sm: 'text-sm', md: 'text-base', lg: 'text-3xl' };

export default function AvatarCircle({ name, avatarUrl, size = 'md' }: Props) {
  const initial = name?.[0]?.toUpperCase() ?? '?';
  return (
    <div className={`${sizes[size]} shrink-0 overflow-hidden rounded-full bg-brand/20`}>
      {avatarUrl ? (
        <img src={avatarUrl} alt="" className="h-full w-full object-cover" />
      ) : (
        <div className={`flex h-full w-full items-center justify-center font-bold text-brand ${textSizes[size]}`}>
          {initial}
        </div>
      )}
    </div>
  );
}
